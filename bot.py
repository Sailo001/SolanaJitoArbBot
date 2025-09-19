#!/usr/bin/env python3
"""
Solana “crocodile” arb bot – free-tier friendly
Waits for *fat* Jupiter round-trip gaps (≥ 2 %) then alerts.
Zero on-chain RPC per token → only 1 Jupiter quote per pair per cycle.
"""

import aiohttp
import asyncio
import json
import os
import time
from datetime import datetime
from flask import Flask, jsonify
import requests
import logging
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed

# ----------------------  CONFIG  ----------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

SOLANA_RPC      = os.getenv("SOLANA_RPC", "https://api.mainnet-beta.solana.com").rstrip()
TELEGRAM_TOKEN  = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID= os.getenv("TELEGRAM_CHAT_ID", "")
TOKEN_FILE      = "tokens.json"
MIN_SPREAD_PCT  = float(os.getenv("MIN_SPREAD_PCT", 2.0))   # ≥ 2 % gap
MIN_USD_PROFIT  = float(os.getenv("MIN_USD_PROFIT", 50.0))  # ≥ $50 net
QUOTE_USDC      = 100_000                                   # $100 test amount (6 dec)
SLIPPAGE_BPS    = int(os.getenv("SLIPPAGE_BPS", 50))
POLL_INTERVAL   = int(os.getenv("POLL_INTERVAL", 15))
JUPITER_URL     = "https://quote-api.jup.ag/v6/quote"
COINGECKO_URL   = "https://api.coingecko.com/api/v3/simple/price"
INVALID_TOKEN_TTL = 600
MAX_CONCURRENT_REQUESTS = 1

USDC_ADDRESS    = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
RATE_LIMIT = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

# ----------------------  COINGECKO ID MAP  ----------------------
COINGECKO_IDS = {
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "dogwifhat",
    "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "popcat",
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "bonk",
    "8sUHD6b9kU7K67264m86o2Tog2xMPf3o3nR5Hwwa8rKn": "moo-deng",
    "3mint6Q7xTusfK2K6mrXhHmt2aT6Nekn7W91A8sK3x": "wen",
    "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": "book-of-meme",
    "7BgBvyjrZX1YKz4ohE0mjb2AjFxFG1Dm1o9XHu7JYRPg": "slerf",
    "3XJ3hW6F1YQGsWQQS3Yx9AuSbhgCRYgqYBF2dNAuJ4xy": "maneki-neko",
    "Mog8U4pDxc58uX1MmxHgH3N4t41pwvXxt2Tq2pC4T6y": "mog-coin",
    "8wXtPeU6557ETKp3m4WcoQh5K8q7qA8PK6Kn4ggL2VU2": "gme",
}

# ----------------------  ARB DETECTOR  ----------------------
class ArbDetector:
    def __init__(self):
        self.invalid_tokens = {}
        self.rpc_client = AsyncClient(SOLANA_RPC)
        self.load_tokens()

    def load_tokens(self):
        if os.path.isfile("tokens.json"):
            with open("tokens.json") as f:
                self.tokens = json.load(f)
                logger.info("Loaded %s tokens from tokens.json", len(self.tokens))
        else:
            logger.info("No tokens.json – will pull trending list at first scan")
            self.tokens = {}

    # ----------  trending mints  ----------
    async def fetch_trending_solana_mints(self, session: aiohttp.ClientSession, needed: int = 300) -> dict:
        BIG_LIST = "https://raw.githubusercontent.com/raydium-io/raydium-liquidity-miner/main/src/raydium-mainnet.json"
        try:
            async with session.get(BIG_LIST, timeout=15) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    out = {}
                    for pool in data:
                        if pool.get("quoteMint") != USDC_ADDRESS:
                            continue
                        liquidity = float(pool.get("liquidity", 0))
                        if liquidity < 2_000:
                            continue
                        mint = pool["baseMint"]
                        symbol = pool.get("symbol", "UNKNOWN")
                        try:
                            Pubkey.from_string(mint)
                            out[symbol] = {"address": mint}
                            if len(out) >= needed:
                                break
                        except Exception:
                            continue
                    if out:
                        logger.info("Loaded %s Raydium pools (≥$2 k) from GitHub", len(out))
                        return out
        except Exception as e:
            logger.warning("Big Raydium list failed: %s", e)

        # fallback – DexScreener pages
        out, page = {}, 1
        while len(out) < min(needed, 200):
            url = f"https://api.dexscreener.com/latest/dex/search?q=solana&page={page}"
            try:
                async with session.get(url, timeout=15) as resp:
                    if resp.status != 200:
                        break
                    data = await resp.json()
                pairs = data.get("pairs", [])
                if not pairs:
                    break
                for pair in pairs:
                    mint = pair["baseToken"]["address"]
                    symbol = pair["baseToken"]["symbol"]
                    if mint.lower() in ("solana", "sol", ""):
                        continue
                    try:
                        Pubkey.from_string(mint)
                        out[symbol] = {"address": mint}
                        if len(out) >= needed:
                            return out
                    except Exception:
                        continue
                page += 1
            except Exception as e:
                logger.error("DexScreener page %s error: %s", page, e)
                break
        logger.info("Fetched %s valid Solana mints (fallback)", len(out))
        return out

    # ----------  Jupiter round-trip quote  ----------
    async def get_jupiter_quote(self, session, input_mint, output_mint, amount, retries=5):
        if input_mint == output_mint:
            return None
        pair = (input_mint, output_mint)
        if pair in self.invalid_tokens and time.time() - self.invalid_tokens[pair] < 600:
            return None
        params = {"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount), "slippageBps": SLIPPAGE_BPS}
        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    async with session.get(JUPITER_URL, params=params, timeout=20) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        if resp.status == 429:
                            await asyncio.sleep(2 ** attempt * 4)
                            continue
                        if resp.status == 400:
                            self.invalid_tokens[pair] = time.time()
                            return None
                        logger.warning("Jupiter %s – %s", resp.status, await resp.text())
                        return None
                except asyncio.TimeoutError:
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
                except Exception as e:
                    logger.error("Jupiter error: %s", e)
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
        return None

    # ----------  USD reference  ----------
    async def get_coingecko_price(self, session, token_address, retries=3):
        cg_id = COINGECKO_IDS.get(token_address)
        if not cg_id:
            return None
        params = {"ids": cg_id, "vs_currencies": "usd"}
        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    async with session.get(COINGECKO_URL, params=params, timeout=20) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            return float(data[cg_id]["usd"])
                        if attempt < retries - 1:
                            await asyncio.sleep(2 ** attempt * 4)
                except Exception as e:
                    logger.error("CoinGecko error: %s", e)
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
        return None

    # ----------  FAT-ARB detector  ----------
    async def detect_arb(self, session: aiohttp.ClientSession, symbol: str, address: str):
        if address == USDC_ADDRESS:
            return None

        # 1️⃣  Single Jupiter round-trip → discovery + execution quote
        q1 = await self.get_jupiter_quote(session, USDC_ADDRESS, address, QUOTE_USDC)
        if not q1:
            return None
        token_out = int(q1["outAmount"])
        q2 = await self.get_jupiter_quote(session, address, USDC_ADDRESS, token_out)
        if not q2:
            return None
        usd_back = int(q2["outAmount"]) / 1_000_000          # USDC has 6 dec
        spread_pct = ((usd_back - QUOTE_USDC / 1_000_000) / (QUOTE_USDC / 1_000_000)) * 100
        logger.debug("%s Jupiter round-trip: %.2f %%", symbol, spread_pct)

        # 2️⃣  Only big gaps & big absolute profit
        net_usd = usd_back - QUOTE_USDC / 1_000_000
        if spread_pct < MIN_SPREAD_PCT or net_usd < MIN_USD_PROFIT:
            return None

        # 3️⃣  Log & notify (no on-chain RPC at all)
        opp = {
            "symbol": symbol,
            "profit_pct": spread_pct,
            "net_usd": net_usd,
            "jup_quote": {"usdc→token": q1, "token→usdc": q2},
        }
        logger.info("FAT ARB: %s  %.2f %%  +$%.2f", symbol, spread_pct, net_usd)
        self.notify_telegram(opp)
        return opp

    # ----------  main scan  ----------
    async def scan(self):
        async with aiohttp.ClientSession() as session:
            if not self.tokens:
                self.tokens = await self.fetch_trending_solana_mints(session, needed=300)
                if not self.tokens:
                    logger.error("No valid tokens – aborting scan")
                    return

            logger.info("Starting scan for %s tokens", len(self.tokens))
            tasks = [
                asyncio.create_task(self.detect_arb(session, sym, info["address"]))
                for sym, info in self.tokens.items()
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            valid = sum(1 for r in results if isinstance(r, dict))
            logger.info("Scan complete – %s fat opportunities", valid)

    # ----------  telegram  ----------
    def notify_telegram(self, opp):
        try:
            msg = f"Fat Arb: {opp['symbol']} | Gap: {opp['profit_pct']:.2f}% | +${opp['net_usd']:.2f}\n"
            msg += f"Execute: https://jup.ag/swap/USDC-{opp['symbol']}"
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg}
            r = requests.get(url, params=payload, timeout=20)
            if r.status_code != 200:
                logger.error("Telegram failed: %s %s", r.status_code, r.text)
            else:
                logger.info("Telegram sent")
        except Exception as e:
            logger.error("Telegram error: %s", e)

# ----------------------  FLASK ROUTES  ----------------------
@app.route("/health")
def health():
    return jsonify({"status": "running"})

@app.route("/test-telegram")
def test_telegram():
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        r = requests.get(url, params={"chat_id": TELEGRAM_CHAT_ID, "text": "Croc-bot online"}, timeout=20)
        return jsonify({"telegram_status": r.status_code})
    except Exception as e:
        return jsonify({"error": str(e)})

# ----------------------  BOT LOOP  ----------------------
async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            await detector.scan()
        except Exception as e:
            logger.error("Scan crash: %s", e)
        await asyncio.sleep(POLL_INTERVAL)

# ----------------------  ENTRY POINT  ----------------------
async def main():
    import threading
    flask_thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080))),
        daemon=True,
    )
    flask_thread.start()
    await run_bot()

if __name__ == "__main__":
    asyncio.run(main())
