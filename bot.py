#!/usr/bin/env python3
"""
Solana arb bot - Enhanced diagnostic version
"""
import aiohttp, asyncio, json, os, time, logging
from datetime import datetime
from flask import Flask, jsonify
import threading, requests
from typing import Dict, List, Optional, Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# --------------------------  config  ---------------------------------------- #
SOLANA_RPC       = os.getenv("SOLANA_RPC", "https://api.mainnet-beta.solana.com")
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "your_bot_token")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "your_chat_id")
TOKEN_FILE       = "tokens.json"
MIN_PROFIT_PCT   = float(os.getenv("MIN_PROFIT_PCT", "0.1"))
SLIPPAGE_BPS     = int(os.getenv("SLIPPAGE_BPS", "50"))
POLL_INTERVAL    = int(os.getenv("POLL_INTERVAL", "5"))
INVALID_TTL      = 600
MAX_CONCURRENT   = int(os.getenv("MAX_CONCURRENT_REQUESTS", "2"))
BATCH_DELAY      = float(os.getenv("BATCH_DELAY", "1.0"))

USDC             = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
JUP_TOKENS_URL   = "https://token.jup.ag/all"
JUP_QUOTE_URL    = "https://quote-api.jup.ag/v6/quote"

# --------------------------------------------------------------------------- #
class MemCache:
    def __init__(self, ttl_seconds: int):
        self.ttl = ttl_seconds
        self._store: Dict[str, tuple[Any, float]] = {}

    def get(self, key: str) -> Optional[Any]:
        if key in self._store:
            val, ts = self._store[key]
            if time.time() - ts < self.ttl:
                return val
            del self._store[key]
        return None

    def set(self, key: str, value: Any):
        self._store[key] = (value, time.time())

token_list_cache = MemCache(300)

def new_session() -> aiohttp.ClientSession:
    conn = aiohttp.TCPConnector(limit=MAX_CONCURRENT*4, limit_per_host=MAX_CONCURRENT*2)
    timeout = aiohttp.ClientTimeout(total=30)
    return aiohttp.ClientSession(connector=conn, timeout=timeout)

# --------------------------------------------------------------------------- #
async def fetch_jupiter_token_list(session: aiohttp.ClientSession) -> List[Dict[str, str]]:
    cached = token_list_cache.get("jup_tokens")
    if cached:
        return cached
    logger.info("Fetching token list from Jupiter")
    try:
        async with session.get(JUP_TOKENS_URL, timeout=15) as resp:
            if resp.status == 200:
                data = await resp.json()
                # Add USDC to the token list
                tokens = [{"symbol": "USDC", "address": USDC, "decimals": 6}]
                for t in data:
                    if t.get("address") and t.get("symbol") and t.get("decimals"):
                        tokens.append({
                            "symbol": t["symbol"],
                            "address": t["address"],
                            "decimals": t["decimals"]
                        })
                logger.info("Fetched %s tokens including USDC", len(tokens))
                token_list_cache.set("jup_tokens", tokens)
                return tokens
            logger.warning("Token list fetch failed: %s - %s", resp.status, await resp.text())
    except Exception as e:
        logger.error("Token list fetch failed: %s", e)
    return []

# --------------------------------------------------------------------------- #
async def jupiter_quote(session: aiohttp.ClientSession, input_mint: str, output_mint: str, amount: int) -> Optional[Dict[str, Any]]:
    if input_mint == output_mint:
        return None
    params = {
        "inputMint": input_mint, 
        "outputMint": output_mint, 
        "amount": str(amount), 
        "slippageBps": SLIPPAGE_BPS
    }
    try:
        async with session.get(JUP_QUOTE_URL, params=params, timeout=15) as resp:
            if resp.status == 200:
                return await resp.json()
            elif resp.status >= 400 and resp.status < 500:
                # Client error, likely invalid pair
                return None
            else:
                logger.warning("Quote API error: %s - %s", resp.status, await resp.text())
                return None
    except asyncio.TimeoutError:
        logger.warning("Quote request timeout for %s→%s", input_mint[:8], output_mint[:8])
        return None
    except Exception as e:
        logger.warning("Quote request failed: %s", e)
        return None

# --------------------------------------------------------------------------- #
class ArbDetector:
    def __init__(self):
        self.invalid: Dict[tuple[str, str], float] = {}
        self.processed_tokens = 0

    async def detect_one(self, session: aiohttp.ClientSession, token: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self.processed_tokens += 1
        symbol, address, decimals = token["symbol"], token["address"], token.get("decimals", 6)
        
        # Skip if we've recently marked this pair as invalid
        if self._is_invalid(USDC, address):
            return None

        # Calculate amount based on token decimals
        amount = 10 * (10 ** 6)  # 10 USDC (6 decimals)
        
        # Get quote from USDC to token
        q1 = await jupiter_quote(session, USDC, address, amount)
        if not q1:
            logger.debug("No quote USDC→%s (%s)", symbol, address)
            self.invalid[(USDC, address)] = time.time()
            return None

        # Get quote from token back to USDC
        q2 = await jupiter_quote(session, address, USDC, int(q1["outAmount"]))
        if not q2:
            logger.debug("No quote %s→USDC (%s)", symbol, address)
            self.invalid[(address, USDC)] = time.time()
            return None

        # Calculate profit percentage
        out_amount = int(q2["outAmount"])
        raw_pct = ((out_amount - amount) / amount) * 100

        # Log all opportunities regardless of profit
        logger.info("ARB_CHECK %s: %.4f%% (in: %d, out: %d)", 
                   symbol, raw_pct, amount, out_amount)
        
        # Check if it meets the minimum profit threshold
        if raw_pct >= MIN_PROFIT_PCT:
            logger.warning("ARB_FOUND %s: %.4f%%", symbol, raw_pct)
            return {
                "symbol": symbol,
                "address": address,
                "profit_pct": raw_pct,
                "in_amount": amount,
                "out_amount": out_amount,
                "routes": [q1.get("routePlan", []), q2.get("routePlan", [])]
            }
        
        return None

    async def scan(self, tokens: List[Dict[str, str]]):
        logger.info("Starting scan of %s tokens", len(tokens))
        self.processed_tokens = 0
        opportunities = []
        
        async with new_session() as session:
            sem = asyncio.Semaphore(MAX_CONCURRENT)
            
            async def process_token(token):
                async with sem:
                    return await self.detect_one(session, token)
            
            # Process tokens in batches
            for i in range(0, len(tokens), MAX_CONCURRENT):
                batch = tokens[i:i+MAX_CONCURRENT]
                tasks = [process_token(token) for token in batch]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                for result in results:
                    if isinstance(result, Exception):
                        logger.error("Error processing token: %s", result)
                    elif result:
                        opportunities.append(result)
                
                await asyncio.sleep(BATCH_DELAY)
        
        logger.info("Scan complete. Processed %d tokens. Found %d opportunities.", 
                   self.processed_tokens, len(opportunities))
        return opportunities

# --------------------------------------------------------------------------- #
app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify(status="running", processed_tokens=arb_detector.processed_tokens)

@app.route("/test-telegram")
def test_telegram():
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        resp = requests.get(url, params={"chat_id": TELEGRAM_CHAT_ID, "text": "Arb bot diagnostic test"}, timeout=20)
        return jsonify(status=resp.status_code)
    except Exception as e:
        return jsonify(status="error", message=str(e))

# --------------------------------------------------------------------------- #
arb_detector = ArbDetector()

async def run_bot():
    logger.info("Starting arb bot")
    while True:
        try:
            async with new_session() as session:
                tokens = await fetch_jupiter_token_list(session)
                if not tokens:
                    logger.warning("Falling back to local tokens.json")
                    try:
                        with open(TOKEN_FILE) as f:
                            token_data = json.load(f)
                            tokens = [{"symbol": k, "address": v["address"], "decimals": v.get("decimals", 6)} 
                                     for k, v in token_data.items()]
                    except Exception as e:
                        logger.error("Failed to load local tokens: %s", e)
                        await asyncio.sleep(POLL_INTERVAL)
                        continue
                
                # Limit to top 100 tokens for testing
                tokens = tokens[:100]
                logger.info("Scanning %d tokens", len(tokens))
                
                opportunities = await arb_detector.scan(tokens)
                for opp in opportunities:
                    logger.warning("Arbitrage opportunity: %s - %.4f%%", opp["symbol"], opp["profit_pct"])
                    
        except Exception as e:
            logger.exception("Error in main loop: %s", e)
        
        await asyncio.sleep(POLL_INTERVAL)

# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    logger.info("Starting arb bot server")
    # Run the bot in a separate thread
    threading.Thread(target=lambda: asyncio.run(run_bot()), daemon=True).start()
    # Start the Flask server
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
