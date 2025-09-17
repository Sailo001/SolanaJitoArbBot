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

# Config
SOLANA_RPC = os.getenv('SOLANA_RPC', 'https://api.mainnet-beta.solana.com')
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN', 'your_bot_token')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', 'your_chat_id')
TOKEN_FILE = 'tokens.json'
MIN_PROFIT_PCT = float(os.getenv('MIN_PROFIT_PCT', 6.0))  # Target +6%
SLIPPAGE_BPS = int(os.getenv('SLIPPAGE_BPS', 50))
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL', 15))
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price"
INVALID_TOKEN_TTL = 600  # Retry after 10 minutes
MAX_CONCURRENT_REQUESTS = 5

# Constants
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

# Map token addresses to CoinGecko IDs
COINGECKO_IDS = {
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'dogwifhat',
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'popcat',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
    '8sUHD6b9kU7K67264m86o2Tog2xMPf3o3nR5Hwwa8rKn': 'moo-deng',
    '9SLPTL41SPsYkgdsMzdfJsxymEANKr5bYoBsQzJyKpKS': 'fartcoin',
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 'book-of-meme',
    '7BgBvyjrZX1YKz4ohE0mjb2AjFxFG1Dm1o9XHu7JYRPg': 'slerf',
    '3XJ3hW6F1YQGsWQQS3Yx9AuSbhgCRYgqYBF2dNAuJ4xy': 'maneki-neko',
    'Mog8U4pDxc58uX1MmxHgH3N4t41pwvXxt2Tq2pC4T6y': 'mog-coin',
    '8wXtPeU6557ETKp3m4WcoQh5K8q7qA8PK6Kn4ggL2VU2': 'gme'
}

# Rate limiter
RATE_LIMIT = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

class ArbDetector:
    def __init__(self):
        self.invalid_tokens = {}  # {pair: timestamp}
        self.load_tokens()

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
                    async with session.get(JUPITER_URL, params=params, timeout=10) as resp:
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

    async def get_coingecko_price(self, session, token_address, retries=3):
        coingecko_id = COINGECKO_IDS.get(token_address)
        if not coingecko_id:
            logger.warning(f"No CoinGecko ID for {token_address}")
            return None
        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    params = {'ids': coingecko_id, 'vs_currencies': 'usd'}
                    async with session.get(COINGECKO_URL, params=params, timeout=10) as resp:
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
        if address == USDC_ADDRESS:
            logger.debug(f"Skipping arbitrage for USDC ({address})")
            return None
        logger.info(f"Starting arb check for {symbol} ({address})")
        try:
            quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
            if not quote1:
                logger.debug(f"No USDC -> {symbol} quote")
                return None
            token_out = int(quote1['outAmount'])
            logger.debug(f"Got USDC -> {symbol}: {token_out} lamports")

            quote2 = await self.get_quote(session, address, USDC_ADDRESS, token_out)
            if not quote2:
                logger.debug(f"No {symbol} -> USDC quote")
                return None
            final_usdc = int(quote2['outAmount'])
            profit_pct = ((final_usdc - amount) / amount) * 100
            logger.info(f"Profit for {symbol}: {profit_pct:.2f}% (direct cycle)")

            if profit_pct >= MIN_PROFIT_PCT:
                jup_price = (amount / token_out) if token_out else 0
                cg_price = await self.get_coingecko_price(session, address)
                price_diff_pct = abs(cg_price - jup_price) / jup_price * 100 if jup_price and cg_price else 0
                if price_diff_pct > 100:
                    price_diff_pct = 0
                opp = {
                    'symbol': symbol,
                    'profit_pct': profit_pct,
                    'jup_quote': {'usdc_to_token': quote1, 'token_to_usdc': quote2},
                    'price_diff_pct': price_diff_pct,
                    'cg_price': cg_price
                }
                logger.info(f"Found arb: {symbol} | Profit: {profit_pct:.2f}% | Price Diff: {price_diff_pct:.2f}% | CoinGecko price: {cg_price or 'N/A'}")
                self.notify_telegram(opp)
                return opp
            return None
        except Exception as e:
            logger.error(f"Error detecting arb for {symbol}: {type(e).__name__}: {e}")
            return None

    async def scan(self):
        self.load_tokens()
        logger.info(f"Starting arbitrage scan for {len(self.tokens)} tokens")
        async with aiohttp.ClientSession() as session:
            tasks = []
            for sym, info in self.tokens.items():
                tasks.append(asyncio.wait_for(self.detect_arb(session, sym, info['address']), timeout=15))
            valid_results = 0
            for i in range(0, len(tasks), MAX_CONCURRENT_REQUESTS):
                batch = tasks[i:i + MAX_CONCURRENT_REQUESTS]
                try:
                    results = await asyncio.gather(*batch, return_exceptions=True)
                    for sym, result in zip(list(self.tokens.keys())[i:i + MAX_CONCURRENT_REQUESTS], results):
                        if isinstance(result, dict):
                            valid_results += 1
                        elif isinstance(result, Exception):
                            logger.error(f"Scan task error for {sym}: {type(result).__name__}: {result}")
                        else:
                            logger.debug(f"No arb opportunity for {sym}")
                except Exception as e:
                    logger.error(f"Batch scan interrupted: {type(e).__name__}: {e}")
                await asyncio.sleep(1.0)
            logger.info(f"Scan completed: {valid_results} valid opportunities found")

    def notify_telegram(self, opp):
        try:
            msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()} | Type: direct\n"
            msg += f"Price Diff: {opp['price_diff_pct']:.2f}% | CoinGecko Price: {opp['cg_price'] or 'N/A'}\n"
            msg += f"Quote (USDC -> {opp['symbol']} -> USDC):\n{json.dumps(opp['jup_quote']['usdc_to_token'], indent=2)}\n"
            msg += f"{opp['symbol']} to USDC: {opp['jup_quote']['token_to_usdc']['outAmount']} lamports\n"
            msg += "Manually execute via Jupiter: https://jup.ag/swap"
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
