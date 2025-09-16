import requests
import json
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/markets"
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
TOKEN_FILE = "tokens.json"

def is_tradable_on_jupiter(address):
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
        return False
    except Exception as e:
        logger.error(f"Error checking tradability for {address}: {e}")
        return False

def fetch_small_cap_tokens(max_tokens=15):
    try:
        params = {
            'vs_currency': 'usd',
            'category': 'solana-ecosystem',
            'order': 'market_cap_desc',
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
            if 1_000_000 <= market_cap <= 500_000_000 and abs(price_change_24h) > 5:  # Volatile small caps
                address = coin.get('contract_address')
                if address and is_tradable_on_jupiter(address):
                    symbol = coin['symbol'].upper()
                    tokens[symbol] = {"address": address}
                    logger.info(f"Added {symbol} ({address}, ${market_cap/1_000_000:.2f}M, {price_change_24h:.2f}%) to token list")
        
        # Ensure base tokens
        base_tokens = {
            "WEPE": {"address": "13hwbtDPhx6G4sN4kJ6LTJD4b1bYqWbQdd426FXDMddY"},
            "HYPER": {"address": "4fYvhTHCPfaS4QixrKrrcQAxqAUYRfJbeGURJEwmPUMP"},
            "SNORT": {"address": "DMXoGAd9Xkdn6uko2AiKEczJicHDyobBpASMPMRPjL2z"},
            "SUBBD": {"address": "333qufn42Vx8fgLS23uG87BMXmn8BtjfURTheZ7xJR6X"},
            "SPY": {"address": "8XsAAThxEuh2SRpmQjJoyqS1oDDu92sNCfeo55Zd5SPY"},
            "PENGU": {"address": "2zMM7o5AMQQkgsXFEQbP9kDMyN5r2v5r8jZ9kDMyN5r"}
        }
        tokens.update(base_tokens)
        
        with open(TOKEN_FILE, 'w') as f:
            json.dump(tokens, f, indent=2)
        logger.info(f"Saved {len(tokens)} tokens to {TOKEN_FILE}")
    except Exception as e:
        logger.error(f"Error fetching tokens: {type(e).__name__}: {e}")

if __name__ == "__main__":
    fetch_small_cap_tokens()
