import aiohttp
import asyncio
import json
import os
import time
import random
from datetime import datetime
from flask import Flask, jsonify
import threading
import requests
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Config
RPC_URL = os.getenv('SOLANA_RPC', 'https://api.mainnet-beta.solana.com')
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN', 'your_bot_token')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', 'your_chat_id')
TOKEN_FILE = 'tokens.json'
MIN_PROFIT_PCT = float(os.getenv('MIN_PROFIT_PCT', 1.0))
SLIPPAGE_BPS = int(os.getenv('SLIPPAGE_BPS', 50))
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL', 60))
PRICE_DIFF_PCT = float(os.getenv('PRICE_DIFF_PCT', 1.0))
USE_RAYDIUM = os.getenv('USE_RAYDIUM', 'false').lower() == 'true'  # Default to false

SOL_ADDRESS = 'So11111111111111111111111111111111111111112'
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
RAYDIUM_URL = "https://api.raydium.io/v2/main/price"

# Rate limiter: 1 request per second
RATE_LIMIT = asyncio.Semaphore(1)

class ArbDetector:
    def __init__(self):
        self.invalid_tokens = set()
        try:
            with open(TOKEN_FILE, 'r') as f:
                self.tokens = json.load(f)
                logger.info(f"Loaded {len(self.tokens)} tokens from {TOKEN_FILE}")
                if not isinstance(self.tokens, dict):
                    raise ValueError("tokens.json must be a dictionary with symbol: {address: ...} structure")
                for symbol, info in self.tokens.items():
                    if not isinstance(info, dict) or 'address' not in info:
                        raise ValueError(f"Invalid token entry for {symbol}: missing 'address'")
        except Exception as e:
            logger.error(f"Failed to load tokens.json: {e}")
            raise

    async def get_quote(self, session, input_mint, output_mint, amount, retries=5):
        if (input_mint, output_mint) in self.invalid_tokens:
            logger.debug(f"Skipping known invalid pair: {input_mint} -> {output_mint}")
            return None
        params = {
            'inputMint': input_mint,
            'outputMint': output_mint,
            'amount': str(amount),
            'slippageBps': SLIPPAGE_BPS
        }
        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    async with session.get(JUPITER_URL, params=params, timeout=15) as resp:  # Increased timeout
                        if resp.status == 200:
                            logger.debug(f"Got quote for {input_mint} -> {output_mint}")
                            return await resp.json()
                        elif resp.status == 429:
                            wait_time = 2 ** attempt
                            logger.warning(f"Jupiter rate limit (429) for {input_mint} -> {output_mint}. Retrying in {wait_time}s (attempt {attempt+1}/{retries})")
                            await asyncio.sleep(wait_time)
                        elif resp.status == 400:
                            error_text = await resp.text()
                            logger.warning(f"Jupiter bad request (400) for {input_mint} -> {output_mint}: {error_text}")
                            self.invalid_tokens.add((input_mint, output_mint))
                            return None
                        else:
                            logger.warning(f"Jupiter quote failed: {resp.status} for {input_mint} -> {output_mint}: {await resp.text()}")
                            return None
                except Exception as e:
                    logger.error(f"Jupiter quote error for {input_mint} -> {output_mint}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt)
                    else:
                        return None
        return None

    async def get_raydium_price(self, session, token_address):
        if not USE_RAYDIUM:
            logger.debug(f"Raydium price check disabled for {token_address}")
            return None
        async with RATE_LIMIT:
            try:
                async with session.get(RAYDIUM_URL, timeout=15) as resp:
                    if resp.status == 200:
                        prices = await resp.json()
                        price = prices.get(token_address)
                        if price:
                            logger.debug(f"Got Raydium price for {token_address}: {price}")
                            return float(price)
                        logger.warning(f"No Raydium price for {token_address}")
                        return None
                    logger.warning(f"Raydium price fetch failed: {resp.status} - {await resp.text()}")
                    return None
            except Exception as e:
                logger.error(f"Raydium price error: {e}")
                return None

    async def detect_arb(self, session, symbol, address, amount=1000000):
        logger.info(f"Starting arb check for {symbol} ({address})")
        if address in [pair[1] for pair in self.invalid_tokens]:
            logger.debug(f"Skipping invalid token {symbol} ({address})")
            return None
        try:
            # USDC -> Token
            quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
            if not quote1:
                logger.debug(f"No USDC -> {symbol} quote")
                return None
            token_out = int(quote1['outAmount'])
            logger.debug(f"Got USDC -> {symbol}: {token_out} lamports")

            # Token -> SOL
            quote2 = await self.get_quote(session, address, SOL_ADDRESS, token_out)
            if not quote2:
                logger.debug(f"No {symbol} -> SOL quote")
                return None
            sol_out = int(quote2['outAmount'])
            logger.debug(f"Got {symbol} -> SOL: {sol_out} lamports")

            # SOL -> USDC
            quote3 = await self.get_quote(session, SOL_ADDRESS, USDC_ADDRESS, sol_out)
            if not quote3:
                logger.debug(f"No SOL -> USDC quote")
                return None
            final_usdc = int(quote3['outAmount'])
            logger.debug(f"Got SOL -> USDC: {final_usdc} lamports")

            profit_pct = ((final_usdc - amount) / amount) * 100
            logger.debug(f"Profit for {symbol}: {profit_pct:.2f}%")
            if profit_pct > MIN_PROFIT_PCT:
                ray_price = await self.get_raydium_price(session, address)
                if ray_price is None:
                    logger.warning(f"Raydium price fetch failed for {symbol} ({address}); proceeding without validation")
                    return {
                        'symbol': symbol,
                        'profit_pct': profit_pct,
                        'jup_quote': {
                            'usdc_to_token': quote1,
                            'token_to_sol': quote2,
                            'sol_to_usdc': quote3
                        },
                        'ray_price': None
                    }
                jup_price = (amount / token_out) if token_out else 0
                if jup_price == 0 or abs(ray_price - jup_price) / jup_price > (PRICE_DIFF_PCT / 100):
                    logger.info(f"Found arb: {symbol} | Profit: {profit_pct:.2f}% | Raydium price: {ray_price}")
                    return {
                        'symbol': symbol,
                        'profit_pct': profit_pct,
                        'jup_quote': {
                            'usdc_to_token': quote1,
                            'token_to_sol': quote2,
                            'sol_to_usdc': quote3
                        },
                        'ray_price': ray_price
                    }
            return None
        except Exception as e:
            logger.error(f"Error detecting arb for {symbol}: {e}")
            return None

    async def scan(self):
        logger.info(f"Starting arbitrage scan for {len(self.tokens)} tokens")
        async with aiohttp.ClientSession() as session:
            tasks = []
            for sym, info in self.tokens.items():
                if info['address'] not in [p[1] for p in self.invalid_tokens]:
                    # Wrap each task with a timeout
                    task = asyncio.wait_for(self.detect_arb(session, sym, info['address']), timeout=30)
                    tasks.append(task)
                    await asyncio.sleep(random.uniform(1.0, 2.0))
            results = await asyncio.gather(*tasks, return_exceptions=True)
            valid_results = 0
            for sym, result in zip(self.tokens.keys(), results):
                if isinstance(result, dict):
                    self.notify_telegram(result)
                    valid_results += 1
                elif isinstance(result, Exception):
                    logger.error(f"Scan task error for {sym}: {result}")
                else:
                    logger.debug(f"No arb opportunity for {sym}")
            logger.info(f"Scan completed: {valid_results} valid opportunities found")

    def notify_telegram(self, opp):
        try:
            msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()}\n"
            msg += f"Quote (USDC to {opp['symbol']}):\n{json.dumps(opp['jup_quote']['usdc_to_token'], indent=2)}\n"
            msg += f"Additional legs: {opp['symbol']} to SOL ({opp['jup_quote']['token_to_sol']['outAmount']} lamports), SOL to USDC ({opp['jup_quote']['sol_to_usdc']['outAmount']} lamports)\n"
            msg += f"Raydium Price: {opp['ray_price'] if opp['ray_price'] is not None else 'N/A'}\n"
            msg += "For MEV protection, execute as Jito bundle: https://jito.wtf/docs/bundles"
            if len(msg) > 4096:
                logger.warning(f"Telegram message for {opp['symbol']} truncated (length {len(msg)} > 4096)")
                msg = msg[:4000] + "... [Truncated]"
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                logger.info(f"Telegram notification sent for {opp['symbol']}")
            else:
                logger.error(f"Telegram failed: {response.status_code} - {response.text}")
        except Exception as e:
            logger.error(f"Telegram error: {e}")

# Flask endpoints
@app.route('/health')
def health():
    return jsonify({'status': 'running'})

@app.route('/test-telegram')
def test_telegram():
    try:
        msg = "Test message from Solana Arb Bot"
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
        response = requests.get(url, timeout=10)
        logger.info(f"Test Telegram: {response.status_code}")
        return jsonify({'status': response.status_code})
    except Exception as e:
        logger.error(f"Test Telegram error: {e}")
        return jsonify({'status': 'error', 'message': str(e)})

async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            await detector.scan()
        except Exception as e:
            logger.error(f"Bot scan failed: {e}")
        await asyncio.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    logger.info("Starting Solana Arb Bot")
    threading.Thread(target=asyncio.run, args=(run_bot(),)).start()
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
