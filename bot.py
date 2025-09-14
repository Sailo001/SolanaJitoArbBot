import aiohttp
import asyncio
import json
import os
import time
from datetime import datetime
from flask import Flask, jsonify
import threading
import requests
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Config (set as env vars on Render)
RPC_URL = os.getenv('SOLANA_RPC', 'https://api.mainnet-beta.solana.com')
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN', 'your_bot_token')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', 'your_chat_id')
TOKEN_FILE = 'tokens.json'
MIN_PROFIT_PCT = float(os.getenv('MIN_PROFIT_PCT', 1.0))
SLIPPAGE_BPS = int(os.getenv('SLIPPAGE_BPS', 50))
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL', 120))  # Increased to 120s for rate limits

SOL_ADDRESS = 'So11111111111111111111111111111111111111112'
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
RAYDIUM_URL = "https://api.raydium.io/v2/main/price"

class ArbDetector:
    def __init__(self):
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

    async def get_quote(self, session, input_mint, output_mint, amount, retries=3):
        params = {
            'inputMint': input_mint,
            'outputMint': output_mint,
            'amount': str(amount),
            'slippageBps': SLIPPAGE_BPS
        }
        for attempt in range(retries):
            try:
                async with session.get(JUPITER_URL, params=params, timeout=10) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    elif resp.status == 429:
                        wait_time = (2 ** attempt) + 1  # Exponential backoff: 1s, 3s, 7s
                        logger.warning(f"Jupiter rate limit (429) for {input_mint} -> {output_mint}; retrying in {wait_time}s (attempt {attempt+1})")
                        await asyncio.sleep(wait_time)
                    else:
                        logger.warning(f"Jupiter quote failed: {resp.status} for {input_mint} -> {output_mint}")
                        return None
            except Exception as e:
                logger.error(f"Jupiter quote error: {e}")
                if attempt == retries - 1:
                    return None
                await asyncio.sleep(2 ** attempt)
        return None

    async def get_raydium_price(self, session, token_address):
        try:
            async with session.get(RAYDIUM_URL, timeout=10) as resp:
                if resp.status == 200:
                    prices = await resp.json()
                    price = prices.get(token_address)
                    if price:
                        return float(price)
                    logger.warning(f"No Raydium price for {token_address}")
                    return None
                logger.warning(f"Raydium price fetch failed: {resp.status}")
                return None
        except Exception as e:
            logger.error(f"Raydium price error: {e}")
            return None

    async def detect_arb(self, session, symbol, address, amount=1000000):
        logger.debug(f"Checking arb for {symbol} ({address})")
        try:
            quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
            if not quote1:
                return None
            token_out = int(quote1['outAmount'])

            quote2 = await self.get_quote(session, address, SOL_ADDRESS, token_out)
            if not quote2:
                return None
            sol_out = int(quote2['outAmount'])

            quote3 = await self.get_quote(session, SOL_ADDRESS, USDC_ADDRESS, sol_out)
            if not quote3:
                return None
            final_usdc = int(quote3['outAmount'])

            profit_pct = ((final_usdc - amount) / amount) * 100
            if profit_pct > MIN_PROFIT_PCT:
                ray_price = await self.get_raydium_price(session, address)
                if ray_price:
                    jup_price = (amount / token_out) if token_out else 0
                    if abs(ray_price - jup_price) / jup_price > 0.01:  # 1% diff for mispricing
                        logger.info(f"Found arb: {symbol} | Profit: {profit_pct:.2f}%")
                        return {
                            'symbol': symbol,
                            'profit_pct': profit_pct,
                            'jup_quote': quote1,
                            'ray_price': ray_price
                        }
            return None
        except Exception as e:
            logger.error(f"Error detecting arb for {symbol}: {e}")
            return None

    async def scan(self):
        logger.info("Starting arbitrage scan")
        connector = aiohttp.TCPConnector(limit=10, limit_per_host=5)  # Limit concurrent connections
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            # Scan in batches to avoid rate limits (e.g., 5 tokens at a time)
            batch_size = 5
            for i in range(0, len(self.tokens), batch_size):
                batch = list(self.tokens.items())[i:i+batch_size]
                tasks = [self.detect_arb(session, sym, info['address']) for sym, info in batch]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for result in results:
                    if isinstance(result, dict):
                        self.notify_telegram(result)
                    elif isinstance(result, Exception):
                        logger.error(f"Scan task error: {result}")
                if i + batch_size < len(self.tokens):
                    await asyncio.sleep(20)  # 20s delay between batches
            logger.info("Scan completed")

    def notify_telegram(self, opp):
        try:
            msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()}\nQuote: {json.dumps(opp['jup_quote'], indent=2)}\nFor MEV protection, execute as Jito bundle: https://jito.wtf/docs/bundles"
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                logger.info(f"Telegram notification sent for {opp['symbol']}")
            else:
                logger.error(f"Telegram failed: {response.status_code} - {response.text}")
        except Exception as e:
            logger.error(f"Telegram error: {e}")

@app.route('/health')
def health():
    return jsonify({'status': 'running'})

@app.route('/test-telegram')
def test_telegram():
    try:
        msg = "Test from Solana Arb Bot - Rate limits fixed!"
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
        response = requests.get(url, timeout=10)
        logger.info(f"Test Telegram: {response.status_code}")
        return jsonify({'status': response.status_code})
    except Exception as e:
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
