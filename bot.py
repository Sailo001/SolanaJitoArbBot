#!/usr/bin/env python3
"""
Solana arbitrage detector – fixed & hardened edition
---------------------------------------------------
- Fixes trailing spaces in URLs
- Fixes Telegram URL construction
- Adds aiohttp TCPConnector with sensible limits
- Adds 60-s in-memory cache for CG prices
- Adds naive circuit-breaker for Jupiter
- Keeps 100 % backward compatibility (env vars, files, routes)
"""

import aiohttp
import asyncio
import json
import os
import time
from datetime import datetime, timedelta
from flask import Flask, jsonify
import threading
import requests
import logging
from typing import Dict, Optional, Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Config – identical names to your original file
# --------------------------------------------------------------------------- #
SOLANA_RPC       = os.getenv("SOLANA_RPC", "https://api.mainnet-beta.solana.com")
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "your_bot_token")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "your_chat_id")
TOKEN_FILE       = "tokens.json"
MIN_PROFIT_PCT   = float(os.getenv("MIN_PROFIT_PCT", "6.0"))
SLIPPAGE_BPS     = int(os.getenv("SLIPPAGE_BPS", "50"))
POLL_INTERVAL    = int(os.getenv("POLL_INTERVAL", "15"))
INVALID_TOKEN_TTL= 600
MAX_CONCURRENT   = int(os.getenv("MAX_CONCURRENT_REQUESTS", "2"))
BATCH_DELAY      = float(os.getenv("BATCH_DELAY", "1.0"))

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
JUPITER_URL  = "https://quote-api.jup.ag/v6/quote"
COINGECKO_URL= "https://api.coingecko.com/api/v3/simple/price"

COINGECKO_IDS: Dict[str, str] = {
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "dogwifhat",
    "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "popcat",
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "bonk",
    "8sUHD6b9kU7K67264m86o2Tog2xMPf3o3nR5Hwwa8rKn": "moo-deng",
    "9SLPTL41SPsYkgdsMzdfJsxymEANKr5bYoBsQzJyKpKS": "fartcoin",
    "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": "book-of-meme",
    "7BgBvyjrZX1YKz4ohE0mjb2AjFxFG1Dm1o9XHu7JYRPg": "slerf",
    "3XJ3hW6F1YQGsWQQS3Yx9AuSbhgCRYgqYBF2dNAuJ4xy": "maneki-neko",
    "Mog8U4pDxc58uX1MmxHgH3N4t41pwvXxt2Tq2pC4T6y": "mog-coin",
    "8wXtPeU6557ETKp3m4WcoQh5K8q7qA8PK6Kn4ggL2VU2": "gme",
}

# --------------------------------------------------------------------------- #
# Utilities
# --------------------------------------------------------------------------- #
class MemoryCache:
    """60-second TTL cache for CoinGecko prices."""
    def __init__(self, ttl: int = 60):
        self._cache: Dict[str, tuple[float, float]] = {}  # id -> (price, ts)
        self.ttl = ttl

    def get(self, key: str) -> Optional[float]:
        if key not in self._cache:
            return None
        val, ts = self._cache[key]
        if time.time() - ts > self.ttl:
            del self._cache[key]
            return None
        return val

    def set(self, key: str, value: float):
        self._cache[key] = (value, time.time())

cg_cache = MemoryCache(60)


class CircuitBreaker:
    """Naive CB for Jupiter calls."""
    def __init__(self, fail_limit: int = 7, restore_secs: int = 60):
        self.fail_limit = fail_limit
        self.restore_secs = restore_secs
        self._failures = 0
        self._last_fail: Optional[float] = None

    def ok(self) -> bool:
        if self._failures < self.fail_limit:
            return True
        assert self._last_fail is not None
        if time.time() - self._last_fail > self.restore_secs:
            self._failures = 0
            return True
        return False

    def record_fail(self):
        self._failures += 1
        self._last_fail = time.time()

    def record_success(self):
        self._failures = 0


jupiter_cb = CircuitBreaker()

# --------------------------------------------------------------------------- #
# aiohttp session helpers
# --------------------------------------------------------------------------- #
def new_session() -> aiohttp.ClientSession:
    conn = aiohttp.TCPConnector(
        limit=MAX_CONCURRENT * 4, limit_per_host=MAX_CONCURRENT * 2
    )
    timeout = aiohttp.ClientTimeout(total=20)
    return aiohttp.ClientSession(connector=conn, timeout=timeout)


# --------------------------------------------------------------------------- #
# Core detector
# --------------------------------------------------------------------------- #
class ArbDetector:
    def __init__(self):
        self.invalid_tokens: Dict[tuple[str, str], float] = {}
        self.tokens: Dict[str, Dict[str, str]] = {}
        self.load_tokens()

    # ----------------------------------------------- #
    def load_tokens(self):
        try:
            with open(TOKEN_FILE) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("tokens.json must be a dict {symbol: {address: ...}}")
            for sym, info in data.items():
                if not isinstance(info, dict) or "address" not in info:
                    raise ValueError(f"Token {sym} missing 'address'")
            self.tokens = data
            logger.info("Loaded %s tokens from %s", len(self.tokens), TOKEN_FILE)
        except Exception as e:
            logger.error("Failed to load tokens.json: %s", e)
            raise

    # ----------------------------------------------- #
    async def get_quote(
        self,
        session: aiohttp.ClientSession,
        input_mint: str,
        output_mint: str,
        amount: int,
        retries: int = 5,
    ) -> Optional[Dict[str, Any]]:
        if input_mint == output_mint:
            return None
        pair = (input_mint, output_mint)
        if pair in self.invalid_tokens and time.time() - self.invalid_tokens[pair] < INVALID_TOKEN_TTL:
            return None
        if not jupiter_cb.ok():
            logger.warning("Jupiter circuit-breaker open – skipping quote")
            return None

        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": SLIPPAGE_BPS,
        }
        for attempt in range(retries):
            try:
                async with session.get(JUPITER_URL, params=params) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        jupiter_cb.record_success()
                        logger.debug("Jupiter quote %s -> %s OK", input_mint, output_mint)
                        return data
                    if resp.status == 429:
                        wait = 4 * (2 ** attempt)
                        logger.warning("Jupiter 429 – retry in %ss", wait)
                        await asyncio.sleep(wait)
                        continue
                    if resp.status == 400:
                        self.invalid_tokens[pair] = time.time()
                        logger.warning("Jupiter 400 – marking %s invalid", pair)
                        return None
                    logger.warning("Jupiter %s – unexpected", resp.status)
            except Exception as e:
                logger.error("Jupiter req failed: %s", e)
            await asyncio.sleep(4 * (2 ** attempt))
        jupiter_cb.record_fail()
        return None

    # ----------------------------------------------- #
    async def get_coingecko_price(
        self, session: aiohttp.ClientSession, token_address: str
    ) -> Optional[float]:
        cg_id = COINGECKO_IDS.get(token_address)
        if not cg_id:
            return None
        cached = cg_cache.get(cg_id)
        if cached is not None:
            return cached

        params = {"ids": cg_id, "vs_currencies": "usd"}
        try:
            async with session.get(COINGECKO_URL, params=params) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    price = data.get(cg_id, {}).get("usd")
                    if price:
                        cg_cache.set(cg_id, float(price))
                        return float(price)
        except Exception as e:
            logger.error("CoinGecko price fail: %s", e)
        return None

    # ----------------------------------------------- #
    async def detect_arb(
        self, session: aiohttp.ClientSession, symbol: str, address: str, amount: int = 100_000_000
    ) -> Optional[Dict[str, Any]]:
        if address == USDC_ADDRESS:
            return None
        logger.info("Arb check %s (%s)", symbol, address)

        q1 = await self.get_quote(session, USDC_ADDRESS, address, amount)
        if not q1:
            return None
        token_out = int(q1["outAmount"])

        q2 = await self.get_quote(session, address, USDC_ADDRESS, token_out)
        if not q2:
            return None
        final_usdc = int(q2["outAmount"])
        profit_pct = ((final_usdc - amount) / amount) * 100
        logger.info("Profit %.2f%% for %s (direct)", profit_pct, symbol)

        if profit_pct >= MIN_PROFIT_PCT:
            jup_price = amount / token_out if token_out else 0
            cg_price = await self.get_coingecko_price(session, address)
            price_diff = (
                abs(cg_price - jup_price) / jup_price * 100
                if cg_price and jup_price
                else 0
            )
            opp = {
                "symbol": symbol,
                "profit_pct": profit_pct,
                "jup_quote": {"usdc_to_token": q1, "token_to_usdc": q2},
                "price_diff_pct": price_diff,
                "cg_price": cg_price,
            }
            self.notify_telegram(opp)
            return opp
        return None

    # ----------------------------------------------- #
    async def scan(self):
        self.load_tokens()
        logger.info("Starting scan for %s tokens", len(self.tokens))
        async with new_session() as session:
            semaphore = asyncio.Semaphore(MAX_CONCURRENT)

            async def _sem_task(sym: str, addr: str):
                async with semaphore:
                    return await self.detect_arb(session, sym, addr)

            tasks = [_sem_task(sym, info["address"]) for sym, info in self.tokens.items()]
            results = []
            for i in range(0, len(tasks), MAX_CONCURRENT):
                batch = tasks[i : i + MAX_CONCURRENT]
                results.extend(await asyncio.gather(*batch, return_exceptions=True))
                await asyncio.sleep(BATCH_DELAY)

            valid = [r for r in results if isinstance(r, dict)]
            logger.info("Scan complete – %s valid opportunities", len(valid))

    # ----------------------------------------------- #
    def notify_telegram(self, opp: Dict[str, Any]) -> None:
        try:
            msg = (
                f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | "
                f"Time: {datetime.now()} | Type: direct\n"
                f"Price Diff: {opp['price_diff_pct']:.2f}% | "
                f"CoinGecko Price: {opp['cg_price'] or 'N/A'}\n"
                f"Quote: {json.dumps(opp['jup_quote']['usdc_to_token'], indent=2)}\n"
                f"{opp['symbol']} -> USDC: {opp['jup_quote']['token_to_usdc']['outAmount']} lamports\n"
                "Execute: https://jup.ag/swap"
            )
            if len(msg) > 4096:
                msg = msg[:4000] + "... [Truncated]"

            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg}
            resp = requests.get(url, params=payload, timeout=20)
            if resp.status_code == 200:
                logger.info("Telegram sent for %s", opp["symbol"])
            else:
                logger.error("Telegram failed %s – %s", resp.status_code, resp.text)
        except Exception as e:
            logger.error("Telegram error: %s", e)


# --------------------------------------------------------------------------- #
# Flask glue
# --------------------------------------------------------------------------- #
app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify(status="running")

@app.route("/test-telegram")
def test_telegram():
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": "Test from Solana Arb Bot"}
        resp = requests.get(url, params=payload, timeout=20)
        logger.info("Test telegram %s", resp.status_code)
        return jsonify(status=resp.status_code)
    except Exception as e:
        logger.error("Test telegram error: %s", e)
        return jsonify(status="error", message=str(e))

# --------------------------------------------------------------------------- #
# Async runner
# --------------------------------------------------------------------------- #
async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            await detector.scan()
        except Exception as e:
            logger.error("Bot scan crashed: %s", e)
        await asyncio.sleep(POLL_INTERVAL)

# --------------------------------------------------------------------------- #
# Entry
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    logger.info("Starting Solana Arb Bot (hardened edition)")
    threading.Thread(target=asyncio.run, args=(run_bot(),), daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
