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
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed

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
DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex/tokens"
INVALID_TOKEN_TTL = 600  # Retry after 10 minutes
MAX_CONCURRENT_REQUESTS = 1  # Avoid 429
BATCH_DELAY = 2.0  # Delay between batches (seconds)

# Constants
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
RAYDIUM_PROGRAM = Pubkey.from_string('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
ORCA_PROGRAM = Pubkey.from_string('9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP')

# Map token addresses to CoinGecko IDs
COINGECKO_IDS = {
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'dogwifhat',
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'popcat',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
    '8sUHD6b9kU7K67264m86o2Tog2xMPf3o3nR5Hwwa8rKn': 'moo-deng',
    '3mint6Q7xTusfK2K6mrXhHmt2aT6Nekn7W91A8sK3x': 'wen',
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
        self.rpc_client = AsyncClient(SOLANA_RPC)
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

    async def get_raydium_pool_price(self, token_address, retries=3):
        """Fetch price from Raydium pool"""
        try:
            # Resolve Raydium pool address for USDC/Token pair
            token_mint = Pubkey.from_string(token_address)
            usdc_mint = Pubkey.from_string(USDC_ADDRESS)
            # Sort mints to get canonical pair (lower address first)
            is_token0 = token_mint < usdc_mint
            pool_mint0 = token_mint if is_token0 else usdc_mint
            pool_mint1 = usdc_mint if is_token0 else token_mint
            # Compute pool address using Raydium's create_pool_keys logic
            pool_address = Pubkey.find_program_address(
                [b"amm", bytes(pool_mint0), bytes(pool_mint1)],
                RAYDIUM_PROGRAM
            )[0]
            for attempt in range(retries):
                try:
                    response = await self.rpc_client.get_account_info(pool_address, commitment=Confirmed)
                    if not response.value or not response.value.data:
                        logger.warning(f"No Raydium pool data for {token_address} at {pool_address}")
                        return None
                    # Parse raw account data (Raydium AMM struct, simplified)
                    data = response.value.data
                    # Raydium AMM pool layout: baseReserve and quoteReserve at fixed offsets
                    # Note: Offsets are approximate based on Raydium's AMM struct; adjust as needed
                    reserve_token = int.from_bytes(data[128:136], 'little')  # Base reserve (8 bytes)
                    reserve_usdc = int.from_bytes(data[136:144], 'little')   # Quote reserve (8 bytes)
                    if reserve_token == 0 or reserve_usdc == 0:
                        logger.warning(f"Invalid reserves for {token_address} on Raydium: token={reserve_token}, usdc={reserve_usdc}")
                        return None
                    price = reserve_usdc / reserve_token if is_token0 else reserve_token / reserve_usdc
                    logger.debug(f"Raydium price for {token_address}: {price:.6f}")
                    return price
                except Exception as e:
                    logger.error(f"Raydium fetch error for {token_address}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        wait_time = 4 * (2 ** attempt)
                        logger.info(f"Retrying in {wait_time}s")
                        await asyncio.sleep(wait_time)
                    return None
        except Exception as e:
            logger.error(f"Raydium pool price error for {token_address}: {type(e).__name__}: {e}")
            return None

    async def get_orca_pool_price(self, token_address, retries=3):
        """Fetch price from Orca Whirlpool (simplified placeholder)"""
        try:
            # Resolve Orca pool address (simplified, assumes known pool)
            token_mint = Pubkey.from_string(token_address)
            usdc_mint = Pubkey.from_string(USDC_ADDRESS)
            # Orca Whirlpool requires specific program data; placeholder for now
            pool_address = Pubkey.find_program_address(
                [b"whirlpool", bytes(token_mint), bytes(usdc_mint)],
                ORCA_PROGRAM
            )[0]
            for attempt in range(retries):
                try:
                    response = await self.rpc_client.get_account_info(pool_address, commitment=Confirmed)
                    if not response.value or not response.value.data:
                        logger.warning(f"No Orca pool data for {token_address} at {pool_address}")
                        return None
                    # Parse raw account data (Orca Whirlpool, simplified)
                    data = response.value.data
                    # Placeholder: Assume reserves at fixed offsets
                    reserve_token = int.from_bytes(data[96:104], 'little')  # Example offset (8 bytes)
                    reserve_usdc = int.from_bytes(data[104:112], 'little')  # Example offset (8 bytes)
                    if reserve_token == 0 or reserve_usdc == 0:
                        logger.warning(f"Invalid reserves for {token_address} on Orca: token={reserve_token}, usdc={reserve_usdc}")
                        return None
                    price = reserve_usdc / reserve_token if token_mint < usdc_mint else reserve_token / reserve_usdc
                    logger.debug(f"Orca price for {token_address}: {price:.6f}")
                    return price
                except Exception as e:
                    logger.error(f"Orca fetch error for {token_address}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        wait_time = 4 * (2 ** attempt)
                        logger.info(f"Retrying in {wait_time}s")
                        await asyncio.sleep(wait_time)
                    return None
        except Exception as e:
            logger.error(f"Orca pool price error for {token_address}: {type(e).__name__}: {e}")
            return None

    async def get_jupiter_quote(self, session, input_mint, output_mint, amount, retries=5):
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
                    async with session.get(JUPITER_URL, params=params, timeout=20) as resp:
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
                            wait_time = 4 * (2 ** attempt)
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
                except asyncio.TimeoutError as e:
                    logger.error(f"Timeout error for Jupiter {input_mint} -> {output_mint}: {e}")
                    if attempt < retries - 1:
                        wait_time = 4 * (2 ** attempt)
                        logger.info(f"Retrying in {wait_time}s")
                        await asyncio.sleep(wait_time)
                    else:
                        return None
                except Exception as e:
                    logger.error(f"Jupiter error for {input_mint} -> {output_mint}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(4 * (2 ** attempt))
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
                    async with session.get(COINGECKO_URL, params=params, timeout=20) as resp:
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
                            await asyncio.sleep(4 * (2 ** attempt))
                        return None
                except asyncio.TimeoutError as e:
                    logger.error(f"Timeout error for CoinGecko {token_address}: {e}")
                    if attempt < retries - 1:
                        wait_time = 4 * (2 ** attempt)
                        logger.info(f"Retrying in {wait_time}s")
                        await asyncio.sleep(wait_time)
                    else:
                        return None
                except Exception as e:
                    logger.error(f"CoinGecko error for {token_address}: {type(e).__name__}: {e}")
                    if attempt < retries - 1:
                        await asyncio.sleep(4 * (2 ** attempt))
                    return None
        logger.warning(f"No CoinGecko price for {coingecko_id} after {retries} attempts")
        return None

    async def detect_arb(self, session, symbol, address, amount=100000000):
        if address == USDC_ADDRESS:
            logger.debug(f"Skipping arbitrage for USDC ({address})")
            return None
        logger.info(f"Starting arb check for {symbol} ({address})")
        try:
            # Get prices from Raydium and Orca
            raydium_price = await self.get_raydium_pool_price(address)
            orca_price = await self.get_orca_pool_price(address)
            if not raydium_price or not orca_price:
                logger.debug(f"No price data for {symbol} (Raydium: {raydium_price}, Orca: {orca_price})")
                return None

            # Calculate arbitrage: Buy on lower price, sell on higher
            buy_dex = 'Raydium' if raydium_price < orca_price else 'Orca'
            sell_dex = 'Orca' if buy_dex == 'Raydium' else 'Raydium'
            buy_price = min(raydium_price, orca_price)
            sell_price = max(raydium_price, orca_price)

            # Calculate profit
            token_out = amount / buy_price if buy_price else 0
            final_usdc = token_out * sell_price if sell_price else 0
            profit_pct = ((final_usdc - amount) / amount) * 100
            logger.info(f"Profit for {symbol}: {profit_pct:.2f}% (Buy on {buy_dex}, Sell on {sell_dex})")

            if profit_pct >= MIN_PROFIT_PCT:
                # Validate with Jupiter quote for manual execution
                quote1 = await self.get_jupiter_quote(session, USDC_ADDRESS, address, amount)
                if not quote1:
                    logger.debug(f"No Jupiter USDC -> {symbol} quote")
                    return None
                token_out_jup = int(quote1['outAmount'])
                quote2 = await self.get_jupiter_quote(session, address, USDC_ADDRESS, token_out_jup)
                if not quote2:
                    logger.debug(f"No Jupiter {symbol} -> USDC quote")
                    return None
                jup_final_usdc = int(quote2['outAmount'])
                jup_profit_pct = ((jup_final_usdc - amount) / amount) * 100

                cg_price = await self.get_coingecko_price(session, address)
                price_diff_pct = abs(cg_price - buy_price) / buy_price * 100 if buy_price and cg_price else 0
                if price_diff_pct > 100:
                    price_diff_pct = 0
                opp = {
                    'symbol': symbol,
                    'profit_pct': profit_pct,
                    'buy_dex': buy_dex,
                    'sell_dex': sell_dex,
                    'buy_price': buy_price,
                    'sell_price': sell_price,
                    'jup_quote': {'usdc_to_token': quote1, 'token_to_usdc': quote2},
                    'jup_profit_pct': jup_profit_pct,
                    'price_diff_pct': price_diff_pct,
                    'cg_price': cg_price
                }
                logger.info(f"Found arb: {symbol} | Profit: {profit_pct:.2f}% | Buy: {buy_dex} | Sell: {sell_dex} | Price Diff: {price_diff_pct:.2f}%")
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
                tasks.append(asyncio.wait_for(self.detect_arb(session, sym, info['address']), timeout=25))
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
                await asyncio.sleep(BATCH_DELAY)
            logger.info(f"Scan completed: {valid_results} valid opportunities found")

    def notify_telegram(self, opp):
        try:
            msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()} | Type: Inter-DEX\n"
            msg += f"Buy on {opp['buy_dex']} at ${opp['buy_price']:.6f}, Sell on {opp['sell_dex']} at ${opp['sell_price']:.6f}\n"
            msg += f"Price Diff: {opp['price_diff_pct']:.2f}% | CoinGecko Price: {opp['cg_price'] or 'N/A'}\n"
            msg += f"Jupiter Quote (USDC -> {opp['symbol']} -> USDC):\n{json.dumps(opp['jup_quote']['usdc_to_token'], indent=2)}\n"
            msg += f"{opp['symbol']} to USDC: {opp['jup_quote']['token_to_usdc']['outAmount']} lamports (Profit: {opp['jup_profit_pct']:.2f}%)\n"
            msg += "Manually execute via Jupiter: https://jup.ag/swap"
            if len(msg) > 4096:
                logger.warning(f"Telegram message for {opp['symbol']} truncated")
                msg = msg[:4000] + "... [Truncated]"
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
            response = requests.get(url, timeout=20)
            if response.status_code == 200:
                logger.info(f"Telegram notification sent for {opp['symbol']}")
            else:
                logger.error(f"Telegram failed: {response.status_code} - {response.text}")
        except Exception as e:
            logger.error(f"Telegram error: {type(e).__name__}: {e}")

    async def refresh_tokens(self, session, limit=10):
        """Fetch trending tokens from DexScreener"""
        try:
            async with session.get(DEXSCREENER_URL, timeout=20) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    new_tokens = {}
                    for pair in data.get('pairs', [])[:limit]:
                        if pair['chainId'] == 'solana' and pair['baseToken']['address'] in COINGECKO_IDS:
                            symbol = pair['baseToken']['symbol']
                            new_tokens[symbol] = {'address': pair['baseToken']['address']}
                    if new_tokens:
                        with open(TOKEN_FILE, 'w') as f:
                            json.dump(new_tokens, f, indent=2)
                        logger.info(f"Refreshed {len(new_tokens)} tokens in {TOKEN_FILE}")
                        self.load_tokens()
                    else:
                        logger.warning("No valid tokens from DexScreener")
                else:
                    logger.error(f"DexScreener fetch failed: {resp.status}")
        except Exception as e:
            logger.error(f"DexScreener error: {type(e).__name__}: {e}")

# Flask endpoints
@app.route('/health')
def health():
    return jsonify({'status': 'running'})

@app.route('/test-telegram')
def test_telegram():
    try:
        msg = "Test message from Solana Arb Bot"
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
        response = requests.get(url, timeout=20)
        logger.info(f"Test Telegram: {response.status_code}")
        return jsonify({'status': response.status_code})
    except Exception as e:
        logger.error(f"Test Telegram error: {type(e).__name__}: {e}")
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/refresh-tokens')
async def refresh_tokens_endpoint():
    try:
        detector = ArbDetector()
        async with aiohttp.ClientSession() as session:
            await detector.refresh_tokens(session)
        return jsonify({'status': 'success', 'message': f'Tokens refreshed in {TOKEN_FILE}'})
    except Exception as e:
        logger.error(f"Refresh tokens error: {type(e).__name__}: {e}")
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
