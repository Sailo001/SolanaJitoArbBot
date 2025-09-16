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
MIN_PROFIT_PCT = float(os.getenv('MIN_PROFIT_PCT', 2.0))  # Lowered to catch more
SLIPPAGE_BPS = int(os.getenv('SLIPPAGE_BPS', 50))
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL', 10))  # Faster scans
PRICE_DIFF_PCT = float(os.getenv('PRICE_DIFF_PCT', 1.0))
USE_RAYDIUM = os.getenv('USE_RAYDIUM', 'true').lower() == 'true'
CYCLE_TYPE = os.getenv('CYCLE_TYPE', 'triangle').lower()  # Prioritize triangle
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
RAYDIUM_URL = "https://api.raydium.io/v2/main/price"
COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price"
X_API_URL = "https://api.x.com/v2/trends"  # Hypothetical X API
INVALID_TOKEN_TTL = 600
MAX_CONCURRENT_REQUESTS = 10

# Constants
SOL_ADDRESS = 'So11111111111111111111111111111111111111112'
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
USDT_ADDRESS = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

# Map token addresses to CoinGecko IDs
COINGECKO_IDS = {
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 'book-of-meme',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'dogwifhat',
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'popcat',
    '7yN93TFSCZqMJD3c7C3jVjdG61bsoN1mB6YntpgtM5tV': 'floki',
    '7BgBvyjrZX1YKz4ohE0mjb2AjFxFG1Dm1o9XHu7JYRPg': 'slerf',
    '3XJ3hW6F1YQGsWQQS3Yx9AuSbhgCRYgqYBF2dNAuJ4xy': 'maneki-neko',
    '6Y8Wfnv4ueKkUMqWgyF6hYb3Z1NCRMBFVLr7X8kCTSuL': 'pengu',
    'Mog8U4pDxc58uX1MmxHgH3N4t41pwvXxt2Tq2pC4T6y': 'mog-coin',
    'B1LLYxoxSsgkWvF5a19TLP3caB9L2MVT5cNEPj3eJ1q': 'billy',
    '8wXtPeU6557ETKp3m4WcoQh5K8q7qA8PK6Kn4ggL2VU2': 'gme'
    # Add more as tokens.json grows
}

# Rate limiter
RATE_LIMIT = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

class ArbDetector:
    def __init__(self):
        self.invalid_tokens = {}
        self.trending_tokens = []
        self.load_tokens()
        self.load_trending_tokens()

    def load_tokens(self):
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
            logger.error(f"Failed to load tokens.json: {type(e).__name__}: {e}")
            raise

    def load_trending_tokens(self):
        try:
            resp = requests.get(X_API_URL, params={'q': 'solana meme coin'}, timeout=10)
            if resp.status_code == 200:
                trends = resp.json().get('trends', [])
                self.trending_tokens = [t['symbol'].upper() for t in trends if t.get('symbol') in self.tokens]
                logger.info(f"Loaded {len(self.trending_tokens)} trending tokens from X: {self.trending_tokens}")
        except Exception as e:
            logger.error(f"Failed to load trending tokens: {type(e).__name__}: {e}")

    async def get_quote(self, session, input_mint, output_mint, amount, retries=5):
        if input_mint == output_mint:
            logger.debug(f"Skipping self-arbitrage: {input_mint} -> {output_mint}")
            return None
        pair = (input_mint, output_mint)
        if pair in self.invalid_tokens and time.time() - self.invalid_tokens[pair] < INVALID_TOKEN_TTL:
            logger.debug(f"Skipping recently invalid pair: {input_mint} -> {output_mint}")
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
                    async with session.get(JUPITER_URL, params=params, timeout=25) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            if not text:
                                logger.warning(f"Empty response from Jupiter for {input_mint} -> {output_mint}")
                                return None
                            try:
                                data = json.loads(text)
                                logger.debug(f"Got Jupiter quote for {input_mint} -> {output_mint}: {data.get('outAmount', 'N/A')} lamports")
                                return data
                            except json.JSONDecodeError as e:
                                logger.error(f"JSON decode error for Jupiter {input_mint} -> {output_mint}: {e}")
                                return None
                        elif resp.status == 429:
                            wait_time = 2 ** (attempt + 1)
                            logger.warning(f"Jupiter rate limit (429) for {input_mint} -> {output_mint}. Retrying in {wait_time}s")
                            await asyncio.sleep(wait_time)
                        elif resp.status == 400:
                            error_text = await resp.text()
                            logger.warning(f"Jupiter bad request (400) for {input_mint} -> {output_mint}: {error_text}")
                            self.invalid_tokens[pair] = time.time()
                            logger.info(f"Marked {input_mint} -> {output_mint} as invalid until {datetime.fromtimestamp(time.time() + INVALID_TOKEN_TTL)}")
                            return None
                        else:
                            logger.warning(f"Jupiter quote failed: {resp.status} for {input_mint} -> {output_mint}: {await resp.text()}")
                            return None
                except Exception as e:
                    logger.error(f"Jupiter error for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                    return None
        logger.debug(f"No quote for {input_mint} -> {output_mint} after {retries} attempts")
        return None

    async def get_raydium_price(self, session, token_address, retries=3):
        if not USE_RAYDIUM:
            logger.debug(f"Raydium price check disabled for {token_address}")
            return None
        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    async with session.get(RAYDIUM_URL, timeout=25) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            if not text:
                                logger.warning(f"Empty response from Raydium for {token_address}")
                                return await self.get_coingecko_price(session, token_address)
                            try:
                                prices = json.loads(text)
                                price = prices.get(token_address)
                                if price:
                                    logger.debug(f"Got Raydium price for {token_address}: {price}")
                                    return float(price)
                                logger.warning(f"No Raydium price for {token_address}")
                                return await self.get_coingecko_price(session, token_address)
                            except json.JSONDecodeError as e:
                                logger.error(f"JSON decode error for Raydium {token_address}: {e}")
                                return await self.get_coingecko_price(session, token_address)
                        logger.warning(f"Raydium price fetch failed: {resp.status}")
                        if attempt < retries - 1:
                            await asyncio.sleep(2 ** (attempt + 1))
                except Exception as e:
                    logger.error(f"Raydium price error for {token_address}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                    else:
                        return await self.get_coingecko_price(session, token_address)
        logger.warning(f"No Raydium price for {token_address} after {retries} attempts")
        return await self.get_coingecko_price(session, token_address)

    async def get_coingecko_price(self, session, token_address, retries=3):
        coingecko_id = COINGECKO_IDS.get(token_address)
        if not coingecko_id:
            logger.warning(f"No CoinGecko ID for {token_address}")
            return None
        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    params = {'ids': coingecko_id, 'vs_currencies': 'usd'}
                    async with session.get(COINGECKO_URL, params=params, timeout=25) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            if not text:
                                logger.warning(f"Empty response from CoinGecko for {coingecko_id}")
                                return None
                            try:
                                data = json.loads(text)
                                price = data.get(coingecko_id, {}).get('usd')
                                if price:
                                    logger.debug(f"Got CoinGecko price for {token_address}: {price}")
                                    return float(price)
                                logger.warning(f"No CoinGecko price for {coingecko_id}")
                                return None
                            except json.JSONDecodeError as e:
                                logger.error(f"JSON decode error for CoinGecko {coingecko_id}: {e}")
                                return None
                        logger.warning(f"CoinGecko price fetch failed: {resp.status}")
                        if attempt < retries - 1:
                            await asyncio.sleep(2 ** (attempt + 1))
                except Exception as e:
                    logger.error(f"CoinGecko price error for {token_address}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
        logger.warning(f"No CoinGecko price for {coingecko_id} after {retries} attempts")
        return None

    async def detect_arb(self, session, symbol, address, amount=100000000):
        if address in [USDC_ADDRESS, USDT_ADDRESS]:
            logger.debug(f"Skipping arbitrage for base token {symbol} ({address})")
            return None
        logger.info(f"Starting arb check for {symbol} ({address})")
        best_profit = None
        best_quotes = None

        # Direct cycle: USDC -> Token -> USDC
        try:
            quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
            if quote1:
                token_out = int(quote1['outAmount'])
                logger.debug(f"Got USDC -> {symbol}: {token_out} lamports")
                quote2 = await self.get_quote(session, address, USDC_ADDRESS, token_out)
                if quote2:
                    final_usdc = int(quote2['outAmount'])
                    profit_pct = ((final_usdc - amount) / amount) * 100
                    logger.info(f"Profit for {symbol}: {profit_pct:.2f}% (direct cycle)")
                    if profit_pct > MIN_PROFIT_PCT:
                        jup_price = (amount / token_out) if token_out else 0
                        ray_price = await self.get_raydium_price(session, address)
                        price_diff_pct = abs(ray_price - jup_price) / jup_price * 100 if jup_price and ray_price else 0
                        if price_diff_pct > 100:
                            price_diff_pct = 0
                        best_profit = {'symbol': symbol, 'profit_pct': profit_pct, 'type': 'direct', 'quotes': {'usdc_to_token': quote1, 'token_to_usdc': quote2}, 'price_diff_pct': price_diff_pct, 'ray_price': ray_price}
        except Exception as e:
            logger.error(f"Direct cycle error for {symbol}: {type(e).__name__}: {e}")

        # Triangle cycle: USDC -> Token -> SOL -> USDC
        try:
            quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
            if quote1:
                token_out = int(quote1['outAmount'])
                quote2 = await self.get_quote(session, address, SOL_ADDRESS, token_out)
                if quote2:
                    sol_out = int(quote2['outAmount'])
                    quote3 = await self.get_quote(session, SOL_ADDRESS, USDC_ADDRESS, sol_out)
                    if quote3:
                        final_usdc = int(quote3['outAmount'])
                        profit_pct = ((final_usdc - amount) / amount) * 100
                        logger.info(f"Profit for {symbol}: {profit_pct:.2f}% (triangle cycle)")
                        if profit_pct > MIN_PROFIT_PCT and (not best_profit or profit_pct > best_profit['profit_pct']):
                            jup_price = (amount / token_out) if token_out else 0
                            ray_price = await self.get_raydium_price(session, address)
                            price_diff_pct = abs(ray_price - jup_price) / jup_price * 100 if jup_price and ray_price else 0
                            if price_diff_pct > 100:
                                price_diff_pct = 0
                            best_profit = {'symbol': symbol, 'profit_pct': profit_pct, 'type': 'triangle', 'quotes': {'usdc_to_token': quote1, 'token_to_sol': quote2, 'sol_to_usdc': quote3}, 'price_diff_pct': price_diff_pct, 'ray_price': ray_price}
        except Exception as e:
            logger.error(f"Triangle cycle error for {symbol}: {type(e).__name__}: {e}")

        # Cross-pair arbitrage: Token A -> Token B -> USDC (for trending tokens)
        if symbol in self.trending_tokens:
            for other_sym, other_info in self.tokens.items():
                if other_sym == symbol or other_info['address'] in [USDC_ADDRESS, USDT_ADDRESS]:
                    continue
                try:
                    quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
                    if quote1:
                        token_out = int(quote1['outAmount'])
                        quote2 = await self.get_quote(session, address, other_info['address'], token_out)
                        if quote2:
                            token_b_out = int(quote2['outAmount'])
                            quote3 = await self.get_quote(session, other_info['address'], USDC_ADDRESS, token_b_out)
                            if quote3:
                                final_usdc = int(quote3['outAmount'])
                                profit_pct = ((final_usdc - amount) / amount) * 100
                                logger.info(f"Profit for {symbol} -> {other_sym} -> USDC: {profit_pct:.2f}% (cross-pair)")
                                if profit_pct > MIN_PROFIT_PCT and (not best_profit or profit_pct > best_profit['profit_pct']):
                                    jup_price = (amount / token_out) if token_out else 0
                                    ray_price = await self.get_raydium_price(session, address)
                                    price_diff_pct = abs(ray_price - jup_price) / jup_price * 100 if jup_price and ray_price else 0
                                    if price_diff_pct > 100:
                                        price_diff_pct = 0
                                    best_profit = {'symbol': f"{symbol}->{other_sym}", 'profit_pct': profit_pct, 'type': 'cross-pair', 'quotes': {'usdc_to_token_a': quote1, 'token_a_to_token_b': quote2, 'token_b_to_usdc': quote3}, 'price_diff_pct': price_diff_pct, 'ray_price': ray_price}
                except Exception as e:
                    logger.error(f"Cross-pair error for {symbol} -> {other_sym}: {type(e).__name__}: {e}")

        if best_profit and best_profit['profit_pct'] >= 6.0:  # Only notify for +6%
            logger.info(f"Found arb: {best_profit['symbol']} | Profit: {best_profit['profit_pct']:.2f}% | Type: {best_profit['type']}")
            return best_profit
        return None

    async def scan(self):
        self.load_tokens()
        self.load_trending_tokens()
        logger.info(f"Starting arbitrage scan for {len(self.tokens)} tokens")
        async with aiohttp.ClientSession() as session:
            tasks = []
            # Prioritize trending tokens
            for sym in self.trending_tokens:
                if sym in self.tokens:
                    tasks.append(asyncio.wait_for(self.detect_arb(session, sym, self.tokens[sym]['address']), timeout=30))
            # Add remaining tokens
            for sym, info in self.tokens.items():
                if sym not in self.trending_tokens:
                    tasks.append(asyncio.wait_for(self.detect_arb(session, sym, info['address']), timeout=30))
            # Batch tasks
            for i in range(0, len(tasks), MAX_CONCURRENT_REQUESTS):
                batch = tasks[i:i + MAX_CONCURRENT_REQUESTS]
                try:
                    results = await asyncio.gather(*batch, return_exceptions=True)
                    for sym, result in zip(list(self.tokens.keys())[i:i + MAX_CONCURRENT_REQUESTS], results):
                        if isinstance(result, dict):
                            self.notify_telegram(result)
                        elif isinstance(result, Exception):
                            logger.error(f"Scan task error for {sym}: {type(result).__name__}: {result}")
                        else:
                            logger.debug(f"No arb opportunity for {sym}")
                except Exception as e:
                    logger.error(f"Batch scan interrupted: {type(e).__name__}: {e}")
                await asyncio.sleep(1.0)
            logger.info(f"Scan completed: {len(self.tokens)} tokens scanned")

    def notify_telegram(self, opp):
        try:
            msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()} | Type: {opp['type']}\n"
            msg += f"Price Diff: {opp['price_diff_pct']:.2f}% | Raydium Price: {opp['ray_price'] or 'N/A'}\n"
            if opp['type'] == 'direct':
                msg += f"Quote (USDC -> {opp['symbol']} -> USDC):\n{json.dumps(opp['quotes']['usdc_to_token'], indent=2)}\n"
                msg += f"{opp['symbol']} to USDC: {opp['quotes']['token_to_usdc']['outAmount']} lamports\n"
            elif opp['type'] == 'triangle':
                msg += f"Quote (USDC -> {opp['symbol']} -> SOL -> USDC):\n{json.dumps(opp['quotes']['usdc_to_token'], indent=2)}\n"
                msg += f"{opp['symbol']} to SOL: {opp['quotes']['token_to_sol']['outAmount']} lamports\n"
                msg += f"SOL to USDC: {opp['quotes']['sol_to_usdc']['outAmount']} lamports\n"
            else:  # cross-pair
                sym_a, sym_b = opp['symbol'].split('->')
                msg += f"Quote (USDC -> {sym_a} -> {sym_b} -> USDC):\n{json.dumps(opp['quotes']['usdc_to_token_a'], indent=2)}\n"
                msg += f"{sym_a} to {sym_b}: {opp['quotes']['token_a_to_token_b']['outAmount']} lamports\n"
                msg += f"{sym_b} to USDC: {opp['quotes']['token_b_to_usdc']['outAmount']} lamports\n"
            msg += "For MEV protection, execute as Jito bundle: https://jito.wtf/docs/bundles"
            if len(msg) > 4096:
                logger.warning(f"Telegram message for {opp['symbol']} truncated")
                msg = msg[:4000] + "... [Truncated]"
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                logger.info(f"Telegram notification sent for {opp['symbol']}")
            else:
                logger.error(f"Telegram failed: {response.status_code} - {response.text}")
        except Exception as e:
            logger.error(f"Telegram error: {type(e).__name__}: {e}")

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
        logger.error(f"Test Telegram error: {type(e).__name__}: {e}")
        return jsonify({'status': 'error', 'message': str(e)})

async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            await detector.scan()
        except Exception as e:
            logger.error(f"Bot scan failed: {type(e).__name__}: {e}")
        await asyncio.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    logger.info("Starting Solana Arb Bot")
    threading.Thread(target=asyncio.run, args=(run_bot(),)).start()
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
