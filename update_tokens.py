import requests
import json
import logging
import re

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/markets"
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
RAYDIUM_POOL_URL = "https://api.raydium.io/v2/amm/pools"
TOKEN_FILE = "tokens.json"

def is_valid_solana_address(address):
    try:
        return len(address) == 44 and re.match(r'^[1-9A-HJ-NP-Za-km-z]+$', address)
    except Exception:
        return False

def has_liquidity_on_raydium(address):
    try:
        resp = requests.get(RAYDIUM_POOL_URL, timeout=10)
        if resp.status_code == 200:
            pools = resp.json()
            for pool in pools:
                if pool.get('base_mint') == address or pool.get('quote_mint') == address:
                    tvl = pool.get('tvl', 0)
                    if tvl > 100_000:  # $100K TVL minimum
                        logger.info(f"Found Raydium pool for {address} with TVL ${tvl/1_000_000:.2f}M")
                        return True
            logger.warning(f"No Raydium pool with sufficient TVL for {address}")
            return False
        logger.warning(f"Raydium pool fetch failed: {resp.status} - {resp.text}")
        return False
    except Exception as e:
        logger.error(f"Error checking Raydium liquidity for {address}: {e}")
        return False

def is_tradable_on_jupiter(address):
    if not is_valid_solana_address(address):
        logger.warning(f"Invalid Solana address: {address}")
        return False
    try:
        params = {
            'inputMint': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  # USDC
            'outputMint': address,
            'amount': '100000000',  # 100 USDC
            'slippageBps': '50'
        }
        resp = requests.get(JUPITER_URL, params=params, timeout=10)
        if resp.status_code == 200:
            text = resp.text
            if not text:
                logger.warning(f"Empty Jupiter response for {address}")
                return False
            try:
                json.loads(text)
                return True
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error for Jupiter {address}: {e}")
                return False
        logger.warning(f"Jupiter error for {address}: {resp.status} - {resp.text}")
        return False
    except Exception as e:
        logger.error(f"Error checking tradability for {address}: {e}")
        return False

def fetch_small_cap_tokens(max_tokens=50):
    try:
        params = {
            'vs_currency': 'usd',
            'category': 'solana-ecosystem',
            'order': 'volume_desc',  # Prioritize high volume
            'per_page': 100,
            'page': 1,
            'price_change_percentage': '24h'
        }
        resp = requests.get(COINGECKO_URL, params=params, timeout=15)
        resp.raise_for_status()
        coins = resp.json()
        
        tokens = {}
        for coin in coins:
            if len(tokens) >= max_tokens:
                break
            market_cap = coin.get('market_cap', 0)
            price_change_24h = coin.get('price_change_percentage_24h', 0)
            volume_24h = coin.get('total_volume', 0)
            if (1_000_000 <= market_cap <= 500_000_000 and 
                abs(price_change_24h) > 5 and 
                volume_24h > 500_000):
                address = coin.get('contract_address')
                if address and is_tradable_on_jupiter(address) and has_liquidity_on_raydium(address):
                    symbol = coin['symbol'].upper()
                    tokens[symbol] = {"address": address}
                    logger.info(f"Added {symbol} ({address}, ${market_cap/1_000_000:.2f}M, {price_change_24h:.2f}%, Vol: ${volume_24h/1_000_000:.2f}M)")
        
        with open(TOKEN_FILE, 'w') as f:
            json.dump(tokens, f, indent=2)
        logger.info(f"Saved {len(tokens)} tokens to {TOKEN_FILE}")
    except Exception as e:
        logger.error(f"Error fetching tokens: {type(e).__name__}: {e}")

if __name__ == "__main__":
    fetch_small_cap_tokens()
