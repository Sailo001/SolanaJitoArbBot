#!/usr/bin/env python3
"""
Solana arbitrage detector – executable-opportunity edition
- Scans every 3 s, 4 concurrent Jupiter calls (still free-tier)
- Dynamic size ladder: 10 → 25 → 50 → 100 USDC
- Liquidity ≥ 1 k USD, slippage ≤ 1 %, profit ≤ $15
- Fetches *real* swap tx from /swap → simulateTransaction
- Prioritises size that keeps slippage < 1 %
"""
import aiohttp, asyncio, json, os, time, logging
from datetime import datetime
from flask import Flask, jsonify
import threading, requests
from typing import Dict, List, Optional, Any
import base64

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# --------------------------  config  ---------------------------------------- #
SOLANA_RPC       = os.getenv("SOLANA_RPC", "https://api.mainnet-beta.solana.com")
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "your_bot_token")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "your_chat_id")
TOKEN_FILE       = "tokens.json"
MIN_PROFIT_PCT   = float(os.getenv("MIN_PROFIT_PCT", "6.0"))
SLIPPAGE_BPS     = int(os.getenv("SLIPPAGE_BPS", "50"))
POLL_INTERVAL    = int(os.getenv("POLL_INTERVAL", "3"))          # <— faster
INVALID_TTL      = 600
MAX_CONCURRENT   = int(os.getenv("MAX_CONCURRENT_REQUESTS", "4")) # <— more parallel
BATCH_DELAY      = float(os.getenv("BATCH_DELAY", "0.5"))

USDC             = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
JUP_TOKENS_URL   = "https://token.jup.ag/strict"
JUP_QUOTE_URL    = "https://quote-api.jup.ag/v6/quote"
JUP_SWAP_URL     = "https://quote-api.jup.ag/v6/swap"
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
    try:
        async with session.get(JUP_TOKENS_URL, timeout=10) as resp:
            if resp.status == 200:
                data = await resp.json()
                tokens = [{"symbol": t["symbol"], "address": t["address"]} for t in data if t.get("address") and t.get("symbol")]
                token_list_cache.set("jup_tokens", tokens)
                logger.info("Fetched %s tokens from %s", len(tokens), JUP_TOKENS_URL)
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

async def coingecko_price(session: aiohttp.ClientSession, address: str) -> Optional[float]:
    mapper = {
        "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "dogwifhat",
        "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "popcat",
        "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "bonk",
        "8sUHD6b9kU7K67264m86o2Tog2xMPf3o3nR5Hwwa8rKn": "moo-deng",
        "9SLPTL41SPsYkgdsMzdfJsxymEANKr5bYoBsQzJyKpKS": "fartcoin",
        "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": "book-of-meme",
        "7BgBvyjrZX1YKz4ohE0mjb2AjFxFG1Dm1o9XHu7JYRPg": "slerf",
        "3XJ3hW6F1YQGsWQQS3Yx9AuSbhgCRYgqYBF2dNAuJ4xy": "maneki-neko",
        "Mog8U4pDxc58uX1MmxHgH3N4t41pwvXxt2Tq2pC4T6y": "mog-coin",
        "8wXtPeU6557ETKp3m4WcoQh5K8q7qA8PK6Kn4ggL2VU2": "gme"
    }
    cg_id = mapper.get(address)
    if not cg_id:
        return None
    cached = cg_price_cache.get(cg_id)
    if cached:
        return cached
    url, params = f"{CG_PRICE_URL}", {"ids": cg_id, "vs_currencies": "usd"}
    try:
        async with session.get(url, params=params) as resp:
            if resp.status == 200:
                price = (await resp.json()).get(cg_id, {}).get("usd")
                if price:
                    cg_price_cache.set(cg_id, float(price))
                    return float(price)
    except Exception as e:
        logger.debug("cg price %s: %s", cg_id, e)
    return None

# --------------------------------------------------------------------------- #
# detector
# --------------------------------------------------------------------------- #
class ArbDetector:
    def __init__(self):
        self.invalid: Dict[tuple[str, str], float] = {}

    def _is_invalid(self, a: str, b: str) -> bool:
        key = (a, b)
        return key in self.invalid and time.time() - self.invalid[key] < INVALID_TTL

    def _mark_invalid(self, a: str, b: str):
        self.invalid[(a, b)] = time.time()

    async def _rp_call(self, session: aiohttp.ClientSession, tx_base64: str) -> int:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "simulateTransaction",
            "params": [tx_base64, {"encoding": "base64", "commitment": "processed"}],
        }
        try:
            async with session.post(SOLANA_RPC, json=payload, timeout=10) as resp:
                if resp.status != 200:
                    return 0
                body = await resp.json()
                if "error" in body:
                    return 0
                accounts = body["result"]["value"]["accounts"]
                for acc in accounts:
                    if acc and acc.get("owner") == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":
                        return int(acc.get("amount", "0"))
        except Exception as e:
            logger.debug("simulateTransaction failed: %s", e)
        return 0

    # --------------------------------------------------------
    #  NEW – dynamic size ladder + real /swap tx
    # --------------------------------------------------------
    async def detect_one(self, session: aiohttp.ClientSession, symbol: str, address: str) -> Optional[Dict[str, Any]]:
        if self._is_invalid(USDC, address) or self._is_invalid(address, USDC):
            return None

        for usd_size in (10, 25, 50, 100):                       # ladder
            amount = usd_size * 1_000_000
            q1 = await jupiter_quote(session, USDC, address, amount)
            if not q1:
                continue
            token_out = int(q1["outAmount"])

            q2 = await jupiter_quote(session, address, USDC, token_out)
            if not q2:
                continue

            liquidity_usd = float(q1.get("liquidity", 0)) + float(q2.get("liquidity", 0))
            if liquidity_usd < 1_000:                              # ≥ 1 k USD
                continue

            slippage = abs(1 - int(q2["outAmount"]) / int(q1["outAmount"])) * 100
            if slippage > 1.0:                                     # ≤ 1 %
                continue

            max_usd_profit = (int(q2["outAmount"]) - amount) / 1_000_000
            if max_usd_profit > 15:                                # ≤ $15
                continue

            # ----  real /swap tx  ---- #
            swap_resp = await session.post(
                JUP_SWAP_URL,
                json={"route": q1, "userPublicKey": "11111111111111111111111111111111"},  # dummy pk
                timeout=15,
            )
            if swap_resp.status != 200:
                continue
            tx_b64 = (await swap_resp.json())["swapTransaction"]

            net_lamports = await self._rp_call(session, tx_b64)
            if net_lamports <= amount:                             # must be > input
                continue

            profit_pct = (net_lamports - amount) / amount * 100
            if profit_pct >= MIN_PROFIT_PCT:
                cg_price = await coingecko_price(session, address)
                opp = {
                    "symbol": symbol,
                    "profit_pct": profit_pct,
                    "size_usd": usd_size,
                    "jup_quote": {"usdc_to_token": q1, "token_to_usdc": q2},
                    "cg_price": cg_price,
                }
                self.notify_telegram(opp)
                return opp
        return None

    async def scan(self, tokens: List[Dict[str, str]]):
        logger.info("Starting scan for %s tokens", len(tokens))
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
            valid = [r for r in results if isinstance(r, dict)]
            logger.info("Scan complete – %s valid opportunities", len(valid))

    def notify_telegram(self, opp: Dict[str, Any]):
        try:
            msg = (
                f"Arb: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | "
                f"Size: {opp['size_usd']} USDC | Time: {datetime.now()}\n"
                f"CoinGecko: {opp['cg_price'] or 'N/A'}\n"
                "Execute: https://jup.ag/swap"
            )
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            resp = requests.get(url, params={"chat_id": TELEGRAM_CHAT_ID, "text": msg}, timeout=20)
            logger.info("Telegram status %s", resp.status_code)
        except Exception as e:
            logger.error("Telegram error: %s", e)

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
        resp = requests.get(url, params={"chat_id": TELEGRAM_CHAT_ID, "text": "Test from dynamic-size bot"}, timeout=20)
        return jsonify(status=resp.status_code)
    except Exception as e:
        return jsonify(status="error", message=str(e))

@app.route("/start-logs")
def start_logs():
    logger.info("KEEP-ALIVE: /start-logs hit – container stays awake")
    return jsonify(status="logs activated – scan lines every {} s".format(POLL_INTERVAL))

# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #
async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            async with new_session() as session:
                tokens = await fetch_jupiter_token_list(session)
                if not tokens:
                    logger.warning("Falling back to tokens.json")
                    with open(TOKEN_FILE) as f:
                        tokens = [{"symbol": k, "address": v["address"]} for k, v in json.load(f).items()]
                await detector.scan(tokens)
        except Exception as e:
            logger.error("Scan crash: %s", e)
        await asyncio.sleep(POLL_INTERVAL)

# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    logger.info("Dynamic-size Solana arb bot starting – logs visible via /start-logs")
    threading.Thread(target=asyncio.run, args=(run_bot(),), daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
