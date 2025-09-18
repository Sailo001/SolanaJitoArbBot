#!/usr/bin/env python3
"""
Solana arb bot – ZERO-FILTER diagnostic edition
Logs every 10-USDC round-trip (no filters) to prove pipeline
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
MIN_PROFIT_PCT   = float(os.getenv("MIN_PROFIT_PCT", "0.1"))        # 0.1 % floor
SLIPPAGE_BPS     = int(os.getenv("SLIPPAGE_BPS", "50"))
POLL_INTERVAL    = int(os.getenv("POLL_INTERVAL", "5"))
INVALID_TTL      = 600
MAX_CONCURRENT   = int(os.getenv("MAX_CONCURRENT_REQUESTS", "2"))     # reduce memory
BATCH_DELAY      = float(os.getenv("BATCH_DELAY", "1.0"))

USDC             = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
JUP_TOKENS_URL   = "https://token.jup.ag/all"                       # big list
JUP_QUOTE_URL    = "https://quote-api.jup.ag/v6/quote"
CG_PRICE_URL     = "https://api.coingecko.com/api/v3/simple/price"

# --------------------------------------------------------------------------- #
# tiny helpers
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
cg_price_cache   = MemCache(60)

def new_session() -> aiohttp.ClientSession:
    conn = aiohttp.TCPConnector(limit=MAX_CONCURRENT*4, limit_per_host=MAX_CONCURRENT*2)
    timeout = aiohttp.ClientTimeout(total=20)
    return aiohttp.ClientSession(connector=conn, timeout=timeout)

# --------------------------------------------------------------------------- #
# token list
# --------------------------------------------------------------------------- #
async def fetch_jupiter_token_list(session: aiohttp.ClientSession) -> List[Dict[str, str]]:
    cached = token_list_cache.get("jup_tokens")
    if cached:
        return cached
    logger.info("Fetching token list from %s", JUP_TOKENS_URL)
    try:
        async with session.get(JUP_TOKENS_URL, timeout=10) as resp:
            if resp.status == 200:
                data = await resp.json()
                tokens = [{"symbol": t["symbol"], "address": t["address"]} for t in data if t.get("address") and t.get("symbol")]
                logger.info("Fetched %s tokens from %s", len(tokens), JUP_TOKENS_URL)
                token_list_cache.set("jup_tokens", tokens)
                return tokens
            logger.warning("token-list %s – %s", resp.status, await resp.text())
    except Exception as e:
        logger.error("token-list fetch failed: %s", e)
    return []

# --------------------------------------------------------------------------- #
# quote & price
# --------------------------------------------------------------------------- #
async def jupiter_quote(session: aiohttp.ClientSession, input_mint: str, output_mint: str, amount: int) -> Optional[Dict[str, Any]]:
    if input_mint == output_mint:
        return None
    params = {"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount), "slippageBps": SLIPPAGE_BPS}
    try:
        async with session.get(JUP_QUOTE_URL, params=params) as resp:
            if resp.status == 200:
                return await resp.json()
            if resp.status == 400:
                return None
            logger.debug("quote %s", resp.status)
    except Exception as e:
        logger.debug("quote err: %s", e)
    return None

# --------------------------------------------------------------------------- #
# detector  –  ZERO-FILTER diagnostic
# --------------------------------------------------------------------------- #
class ArbDetector:
    def __init__(self):
        self.invalid: Dict[tuple[str, str], float] = {}

    def _is_invalid(self, a: str, b: str) -> bool:
        key = (a, b)
        return key in self.invalid and time.time() - self.invalid[key] < INVALID_TTL

    # ----  DIAGNOSTIC: no filters, just log  ---- #
    async def detect_one(self, session: aiohttp.ClientSession, symbol: str, address: str) -> Optional[Dict[str, Any]]:
        amount = 10 * 1_000_000                                    # 10 USDC only
        q1 = await jupiter_quote(session, USDC, address, amount)
        if not q1:
            logger.debug("NO QUOTE  %s  USDC→%s", symbol, address)
            return None
        q2 = await jupiter_quote(session, address, USDC, int(q1["outAmount"]))
        if not q2:
            logger.debug("NO QUOTE  %s  %s→USDC", symbol, address)
            return None
        raw_pct = ((int(q2["outAmount"]) - amount) / amount) * 100
        logger.info("RAW  %s  %.2f%%  in=%s  out=%s", symbol, raw_pct, amount, q2["outAmount"])
        return None                                                # never alert

    async def scan(self, tokens: List[Dict[str, str]]):
        logger.info("Starting RAW scan for %s tokens", len(tokens))
        sem = asyncio.Semaphore(MAX_CONCURRENT)
        async with new_session() as session:
            async def _job(t: Dict[str, str]):
                async with sem:
                    return await self.detect_one(session, t["symbol"], t["address"])
            tasks = [_job(t) for t in tokens]
            results = []
            for i in range(0, len(tasks), MAX_CONCURRENT):
                batch = tasks[i : i + MAX_CONCURRENT]
                results.extend(await asyncio.gather(*batch, return_exceptions=True))
                await asyncio.sleep(BATCH_DELAY)
            logger.info("RAW scan complete – logged above")

    def notify_telegram(self, opp: Dict[str, Any]):
        pass                                                    # disabled for test

# --------------------------------------------------------------------------- #
# flask
# --------------------------------------------------------------------------- #
app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify(status="running")

@app.route("/test-telegram")
def test_telegram():
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        resp = requests.get(url, params={"chat_id": TELEGRAM_CHAT_ID, "text": "Raw-quote diagnostic bot"}, timeout=20)
        return jsonify(status=resp.status_code)
    except Exception as e:
        return jsonify(status="error", message=str(e))

@app.route("/start-logs")
def start_logs():
    logger.info("KEEP-ALIVE: /start-logs hit – container stays awake")
    return jsonify(status="raw logs active every {} s".format(POLL_INTERVAL))

# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #
async def run_bot():
    logger.info("BOOT: entering run_bot loop")
    detector = ArbDetector()
    while True:
        try:
            logger.info("BOOT: about to fetch token list")
            async with new_session() as session:
                tokens = await fetch_jupiter_token_list(session)
                if not tokens:
                    logger.warning("BOOT: falling back to tokens.json")
                    with open(TOKEN_FILE) as f:
                        tokens = [{"symbol": k, "address": v["address"]} for k, v in json.load(f).items()]
                logger.info("BOOT: starting RAW scan for %s tokens", len(tokens))
                await detector.scan(tokens)
        except Exception as e:
            logger.exception("BOOT: crash in run_bot: %s", e)
        await asyncio.sleep(POLL_INTERVAL)

# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    logger = logging.getLogger(__name__)
    logger.info("RAW-QUOTE diagnostic bot starting – logs visible via /start-logs")
    threading.Thread(target=lambda: asyncio.run(run_bot()), daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
