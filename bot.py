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
MIN_PROFIT_PCT = float(os.getenv('MIN_PROFIT_PCT', 0.5))
SLIPPAGE_BPS = int(os.getenv('SLIPPAGE_BPS', 50))
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL', 30))
PRICE_DIFF_PCT = float(os.getenv('PRICE_DIFF_PCT', 1.0))
USE_RAYDIUM = os.getenv('USE_RAYDIUM', 'true').lower() == 'true'
CYCLE_TYPE = os.getenv('CYCLE_TYPE', 'direct').lower()
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
RAYDIUM_URL = "https://api.raydium.io/v2/main/price"
COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price"

# Constants
SOL_ADDRESS = 'So11111111111111111111111111111111111111112'
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
USDT_ADDRESS = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

# Map token addresses to CoinGecko IDs
COINGECKO_IDS = {
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 'book-of-meme',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'dogwifhat',
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'popcat',
    '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': 'maga',
    'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump': 'goatseus-maximus'
}

# Rate limiter: 0.3 requests per second
RATE_LIMIT = asyncio.Semaphore(0.3)

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
            logger.error(f"Failed to load tokens.json: {type(e).__name__}: {e}")
            raise

    async def get_quote(self, session, input_mint, output_mint, amount, retries=5):
        if input_mint == output_mint:
            logger.debug(f"Skipping self-arbitrage: {input_mint} -> {output_mint}")
            return None
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
                    async with session.get(JUPITER_URL, params=params, timeout=25) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            logger.debug(f"Got Jupiter quote for {input_mint} -> {output_mint}: {data['outAmount']} lamports")
                            return data
                        elif resp.status == 429:
                            wait_time = 2 ** attempt
                            logger.warning(f"Jupiter rate limit (429) for {input_mint} -> {output_mint}. Retrying in {wait_time}s (attempt {attempt+1}/{retries})")
                            await asyncio.sleep(wait_time)
                        elif resp.status == 400:
                            error_text = await resp.text()
                            logger.warning(f"Jupiter bad request (400) for {input_mint} -> {output_mint}: {error_text}")
                            self.invalid_tokens.add((input_mint, output_mint))
                            logger.info(f"Marked {input_mint} -> {output_mint} as invalid")
                            return None
                        else:
                            logger.warning(f"Jupiter quote failed: {resp.status} for {input_mint} -> {output_mint}: {await resp.text()}")
                            return None
                except RuntimeError as e:
                    if "Session is closed" in str(e):
                        logger.error(f"Session closed for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
                        async with aiohttp.ClientSession() as new_session:
                            return await self.get_quote(new_session, input_mint, output_mint, amount, retries=1)
                    else:
                        logger.error(f"RuntimeError for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
                        return None
                except asyncio.TimeoutError as e:
                    logger.error(f"Jupiter timeout for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt)
                    else:
                        logger.debug(f"No quote for {input_mint} -> {output_mint} after {retries} attempts (timeout)")
                        return None
                except aiohttp.ClientResponseError as e:
                    logger.error(f"Jupiter response error for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
                    return None
                except Exception as e:
                    logger.error(f"Jupiter unexpected error for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
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
                            prices = await resp.json()
                            price = prices.get(token_address)
                            if price:
                                logger.debug(f"Got Raydium price for {token_address}: {price}")
                                return float(price)
                            logger.warning(f"No Raydium price for {token_address}")
                            return await self.get_coingecko_price(session, token_address)
                        logger.warning(f"Raydium price fetch failed: {resp.status} - {await resp.text()}")
                        if attempt < retries - 1:
                            await asyncio.sleep(2 ** attempt)
                    except Exception as e:
                        logger.error(f"Raydium price error: {type(e).__name__}: {e}")
                        if attempt < retries - 1:
                            await asyncio.sleep(2 ** attempt)
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
                            data = await resp.json()
                            price = data.get(coingecko_id, {}).get('usd')
                            if price:
                                logger.debug(f"Got CoinGecko price for {token_address}: {price}")
                                return float(price)
                            logger.warning(f"No CoinGecko price for {coingecko_id}")
                            return None
                        logger.warning(f"CoinGecko price fetch failed: {resp.status} - {await resp.text()}")
                        if attempt < retries - 1:
                            await asyncio.sleep(2 ** attempt)
                except Exception as e:
                    logger.error(f"CoinGecko price error for {token_address}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt)
        logger.warning(f"No CoinGecko price for {coingecko_id} after {retries} attempts")
        return None

    async def detect_arb(self, session, symbol, address, amount=100000000):  # 100 USDC
        if address in [USDC_ADDRESS, USDT_ADDRESS]:
            logger.debug(f"Skipping arbitrage for base token {symbol} ({address})")
            return None
        logger.info(f"Starting arb check for {symbol} ({address})")
        if address in [pair[1] for pair in self.invalid_tokens]:
            logger.debug(f"Skipping invalid token {symbol} ({address})")
            return None
        try:
            # Try direct cycle first
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
            logger.debug(f"Got {symbol} -> USDC: {final_usdc} lamports")

            profit_pct = ((final_usdc - amount) / amount) * 100
            logger.info(f"Profit for {symbol}: {profit_pct:.2f}% (direct cycle)")

            # Calculate price difference with decimal adjustment
            jup_price = (amount / token_out) if token_out else 0
            ray_price = await self.get_raydium_price(session, address)
            if jup_price and ray_price and abs(jup_price) > 0:
                price_diff_pct = abs(ray_price - jup_price) / jup_price * 100
                if price_diff_pct > 100:  # Cap unrealistic differences
                    logger.warning(f"Unrealistic price difference for {symbol}: {price_diff_pct:.2f}% (Jupiter: {jup_price:.6f}, Raydium: {ray_price:.6f})")
                    price_diff_pct = 0
            else:
                price_diff_pct = 0
            logger.info(f"Price difference for {symbol}: {price_diff_pct:.2f}% (Jupiter: {jup_price:.6f}, Raydium: {ray_price or 'N/A'})")

            # Fallback to triangle cycle if direct profit < 1%
            if profit_pct < 1.0:
                logger.info(f"Direct cycle profit too low for {symbol} ({profit_pct:.2f}%), trying triangle cycle")
                quote1_tri = await self.get_quote(session, USDC_ADDRESS, address, amount)
                if not quote1_tri:
                    logger.debug(f"No USDC -> {symbol} quote (triangle)")
                    return None
                token_out_tri = int(quote1_tri['outAmount'])
                logger.debug(f"Got USDC -> {symbol}: {token_out_tri} lamports (triangle)")

                quote2_tri = await self.get_quote(session, address, SOL_ADDRESS, token_out_tri)
                if not quote2_tri:
                    logger.debug(f"No {symbol} -> SOL quote (triangle)")
                    return None
                sol_out = int(quote2_tri['outAmount'])
                logger.debug(f"Got {symbol} -> SOL: {sol_out} lamports (triangle)")

                quote3_tri = await self.get_quote(session, SOL_ADDRESS, USDC_ADDRESS, sol_out)
                if not quote3_tri:
                    logger.debug(f"No SOL -> USDC quote (triangle)")
                    return None
                final_usdc_tri = int(quote3_tri['outAmount'])
                logger.debug(f"Got SOL -> USDC: {final_usdc_tri} lamports (triangle)")

                profit_pct_tri = ((final_usdc_tri - amount) / amount) * 100
                logger.info(f"Profit for {symbol}: {profit_pct_tri:.2f}% (triangle cycle)")
                if profit_pct_tri > profit_pct:
                    profit_pct = profit_pct_tri
                    quote1, quote2, quote3 = quote1_tri, quote2_tri, quote3_tri
                else:
                    quote3 = None  # Keep direct cycle quotes

            if profit_pct > MIN_PROFIT_PCT:
                if ray_price is None:
                    logger.info(f"Proceeding without Raydium validation for {symbol}")
                    return {
                        'symbol': symbol,
                        'profit_pct': profit_pct,
                        'jup_quote': {
                            'usdc_to_token': quote1,
                            'token_to_sol': quote2 if CYCLE_TYPE == 'triangle' or quote3 is not None else None,
                            'sol_to_usdc': quote3 if CYCLE_TYPE == 'triangle' or quote3 is not None else None,
                            'token_to_usdc': quote2 if CYCLE_TYPE == 'direct' and quote3 is None else None
                        },
                        'ray_price': None,
                        'price_diff_pct': price_diff_pct
                    }
                if jup_price == 0 or price_diff_pct > PRICE_DIFF_PCT:
                    logger.info(f"Found arb: {symbol} | Profit: {profit_pct:.2f}% | Price Diff: {price_diff_pct:.2f}% | Raydium price: {ray_price}")
                    return {
                        'symbol': symbol,
                        'profit_pct': profit_pct,
                        'jup_quote': {
                            'usdc_to_token': quote1,
                            'token_to_sol': quote2 if CYCLE_TYPE == 'triangle' or quote3 is not None else None,
                            'sol_to_usdc': quote3 if CYCLE_TYPE == 'triangle' or quote3 is not None else None,
                            'token_to_usdc': quote2 if CYCLE_TYPE == 'direct' and quote3 is None else None
                        },
                        'ray_price': ray_price,
                        'price_diff_pct': price_diff_pct
                    }
            return None
        except asyncio.TimeoutError as e:
            logger.error(f"Timeout detecting arb for {symbol}: {type(e).__name__}: {e}")
            return None
        except RuntimeError as e:
            if "Session is closed" in str(e):
                logger.error(f"Session closed for {symbol}: {type(e).__name__}: {e}")
                return None
            else:
                logger.error(f"RuntimeError for {symbol}: {type(e).__name__}: {e}")
                return None
        except Exception as e:
            logger.error(f"Error detecting arb for {symbol}: {type(e).__name__}: {e}")
            return None

    async def scan(self):
        logger.info(f"Starting arbitrage scan for {len(self.tokens)} tokens")
        async with aiohttp.ClientSession() as session:
            tasks = []
            for sym, info in self.tokens.items():
                task = asyncio.wait_for(self.detect_arb(session, sym, info['address']), timeout=30)
                tasks.append(task)
                await asyncio.sleep(random.uniform(2.0, 3.0))
            try:
                results = await asyncio.gather(*tasks, return_exceptions=True)
                valid_results = 0
                for sym, result in zip(self.tokens.keys(), results):
                    if isinstance(result, dict):
                        self.notify_telegram(result)
                        valid_results += 1
                    elif isinstance(result, Exception):
                        logger.error(f"Scan task error for {sym}: {type(result).__name__}: {result}")
                    else:
                        logger.debug(f"No arb opportunity for {sym}")
                logger.info(f"Scan completed: {valid_results} valid opportunities found")
            except Exception as e:
                logger.error(f"Scan interrupted: {type(e).__name__}: {e}")
                raise

    def notify_telegram(self, opp):
        try:
            msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()} | Cycle: {'triangle' if opp['jup_quote']['sol_to_usdc'] else 'direct'}\n"
            msg += f"Price Diff: {opp['price_diff_pct']:.2f}% | Raydium Price: {opp['ray_price'] or 'N/A'}\n"
            msg += f"Quote (USDC to {opp['symbol']}):\n{json.dumps(opp['jup_quote']['usdc_to_token'], indent=2)}\n"
            if opp['jup_quote']['sol_to_usdc']:
                msg += f"{opp['symbol']} to SOL: {opp['jup_quote']['token_to_sol']['outAmount']} lamports\n"
                msg += f"SOL to USDC: {opp['jup_quote']['sol_to_usdc']['outAmount']} lamports\n"
            else:
                msg += f"{opp['symbol']} to USDC: {opp['jup_quote']['token_to_usdc']['outAmount']} lamports\n"
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
            error_type = type(e).__name__
            logger.error(f"Bot scan failed: {error_type}: {e}")
        await asyncio.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    logger.info("Starting Solana Arb Bot")
    threading.Thread(target=asyncio.run, args=(run_bot(),)).start()
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
