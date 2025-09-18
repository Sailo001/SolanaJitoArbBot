#!/usr/bin/env python3
"""
Solana inter-DEX arbitrage scanner  (Raydium ⇄ Orca)
Zero-config – pulls 200+ liquid Raydium pools + DexScreener fallback
No tokens.json required; addresses validated on-the-fly.
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

# ------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Flask app
# ------------------------------------------------------------------
app = Flask(__name__)

# ------------------------------------------------------------------
# Config  (strip trailing spaces!)
# ------------------------------------------------------------------
SOLANA_RPC = os.getenv("SOLANA_RPC", "https://api.mainnet-beta.solana.com").rstrip()
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
TOKEN_FILE = "tokens.json"
MIN_PROFIT_PCT = float(os.getenv("MIN_PROFIT_PCT", 6.0))
SLIPPAGE_BPS = int(os.getenv("SLIPPAGE_BPS", 50))
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", 15))
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price"
INVALID_TOKEN_TTL = 600
MAX_CONCURRENT_REQUESTS = 1
BATCH_DELAY = 2.0

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------
USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
RAYDIUM_PROGRAM = Pubkey.from_string("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
ORCA_PROGRAM = Pubkey.from_string("9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP")

# ------------------------------------------------------------------
# CoinGecko ID map  (used when we want a USD reference)
# ------------------------------------------------------------------
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

# ------------------------------------------------------------------
# Rate limiter
# ------------------------------------------------------------------
RATE_LIMIT = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

# ------------------------------------------------------------------
# ArbDetector
# ------------------------------------------------------------------
class ArbDetector:
    def __init__(self):
        self.invalid_tokens = {}
        self.rpc_client = AsyncClient(SOLANA_RPC)
        self.load_tokens()

    # ------------------------------------------------------------------
    def load_tokens(self):
        """
        If tokens.json exists → use it.
        Otherwise leave self.tokens empty; scan() will pull from on-chain lists.
        """
        if os.path.isfile(TOKEN_FILE):
            with open(TOKEN_FILE) as f:
                self.tokens = json.load(f)
                logger.info("Loaded %s tokens from %s", len(self.tokens), TOKEN_FILE)
        else:
            logger.info("No %s found – will pull large token list at first scan", TOKEN_FILE)
            self.tokens = {}

    # ------------------------------------------------------------------
    # Large liquid token list  (Raydium GitHub)  +  DexScreener fallback
    # ------------------------------------------------------------------
    async def fetch_trending_solana_mints(self, session: aiohttp.ClientSession, needed: int = 250) -> dict:
        BIG_LIST = "https://raw.githubusercontent.com/raydium-io/raydium-liquidity-miner/main/src/raydium-mainnet.json"

        # 1️⃣  Try Raydium’s public JSON first
        try:
            async with session.get(BIG_LIST, timeout=15) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    out = {}
                    for pool in data:
                        if pool.get("quoteMint") != USDC_ADDRESS:
                            continue
                        liquidity = float(pool.get("liquidity", 0))
                        if liquidity < 5_000:        # ≥ $5 k – lower if you want
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
                        logger.info("Loaded %s Raydium pools (≥$5 k) from GitHub", len(out))
                        return out
        except Exception as e:
            logger.warning("Big Raydium list failed: %s", e)

        # 2️⃣  Fallback: paginated DexScreener search
        out, page = {}, 1
        while len(out) < min(needed, 200):   # cap pages to avoid rate-limits
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

    # ------------------------------------------------------------------
    # Raydium AMM v4 price
    # ------------------------------------------------------------------
    async def get_raydium_pool_price(self, token_address: str, retries=3):
        try:
            token_mint = Pubkey.from_string(token_address)
            usdc_mint = Pubkey.from_string(USDC_ADDRESS)
            mint_a, mint_b = (
                (token_mint, usdc_mint) if token_mint < usdc_mint else (usdc_mint, token_mint)
            )
            pool_addr = Pubkey.find_program_address(
                [b"amm", bytes(mint_a), bytes(mint_b)], RAYDIUM_PROGRAM
            )[0]

            for attempt in range(retries):
                try:
                    resp = await self.rpc_client.get_account_info(pool_addr, commitment=Confirmed)
                    if not resp.value or not resp.value.data:
                        return None
                    data = resp.value.data
                    base_r = int.from_bytes(data[64:72], "little")
                    quote_r = int.from_bytes(data[72:80], "little")
                    if base_r == 0 or quote_r == 0:
                        return None
                    is_token0 = token_mint < usdc_mint
                    price = (quote_r / base_r) if is_token0 else (base_r / quote_r)
                    return price
                except Exception as e:
                    logger.debug("Raydium fetch attempt %s: %s", attempt + 1, e)
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
            return None
        except Exception as e:
            logger.error("Raydium price error: %s", e)
            return None

    # ------------------------------------------------------------------
    # Orca Whirlpool price (0.3 % tier)
    # ------------------------------------------------------------------
    async def get_orca_pool_price(self, token_address: str, retries=3):
        try:
            token_mint = Pubkey.from_string(token_address)
            usdc_mint = Pubkey.from_string(USDC_ADDRESS)
            mint_a, mint_b = (
                (token_mint, usdc_mint) if token_mint < usdc_mint else (usdc_mint, token_mint)
            )
            pool_addr = Pubkey.find_program_address(
                [b"whirlpool", bytes(mint_a), bytes(mint_b), b"\x0b\xb8"], ORCA_PROGRAM
            )[0]

            for attempt in range(retries):
                try:
                    resp = await self.rpc_client.get_account_info(pool_addr, commitment=Confirmed)
                    if not resp.value or not resp.value.data:
                        return None
                    data = resp.value.data
                    vault_a = int.from_bytes(data[64:80], "little")
                    vault_b = int.from_bytes(data[80:96], "little")
                    if vault_a == 0 or vault_b == 0:
                        return None
                    is_token0 = token_mint < usdc_mint
                    price = (vault_b / vault_a) if is_token0 else (vault_a / vault_b)
                    return price
                except Exception as e:
                    logger.debug("Orca fetch attempt %s: %s", attempt + 1, e)
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
            return None
        except Exception as e:
            logger.error("Orca price error: %s", e)
            return None

    # ------------------------------------------------------------------
    # Jupiter quote
    # ------------------------------------------------------------------
    async def get_jupiter_quote(
        self, session: aiohttp.ClientSession, input_mint: str, output_mint: str, amount: int, retries=5
    ):
        if input_mint == output_mint:
            return None
        pair = (input_mint, output_mint)
        if pair in self.invalid_tokens and time.time() - self.invalid_tokens[pair] < INVALID_TOKEN_TTL:
            return None

        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": SLIPPAGE_BPS,
        }

        for attempt in range(retries):
            async with RATE_LIMIT:
                try:
                    async with session.get(JUPITER_URL, params=params, timeout=20) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        if resp.status == 429:
                            wait = 2 ** attempt * 4
                            logger.warning("Jupiter 429 – wait %ss", wait)
                            await asyncio.sleep(wait)
                            continue
                        if resp.status == 400:
                            self.invalid_tokens[pair] = time.time()
                            return None
                        logger.warning("Jupiter %s – %s", resp.status, await resp.text())
                        return None
                except asyncio.TimeoutError:
                    logger.warning("Jupiter timeout (attempt %s)", attempt + 1)
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
                except Exception as e:
                    logger.error("Jupiter error: %s", e)
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt * 4)
        return None

    # ------------------------------------------------------------------
    # CoinGecko USD price
    # ------------------------------------------------------------------
    async def get_coingecko_price(
        self, session: aiohttp.ClientSession, token_address: str, retries=3
    ):
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

    # ------------------------------------------------------------------
    # Core arbitrage detection
    # ------------------------------------------------------------------
    async def detect_arb(
        self, session: aiohttp.ClientSession, symbol: str, address: str, amount=100_000_000
    ):
        if address == USDC_ADDRESS:
            return None
        logger.info("Checking arb for %s", symbol)

        ray_price = await self.get_raydium_pool_price(address)
        orca_price = await self.get_orca_pool_price(address)
        if ray_price is None or orca_price is None:
            return None

        buy_dex, sell_dex = ("Raydium", "Orca") if ray_price < orca_price else ("Orca", "Raydium")
        buy_price, sell_price = min(ray_price, orca_price), max(ray_price, orca_price)
        token_out = amount / buy_price
        final_usdc = token_out * sell_price
        profit_pct = ((final_usdc - amount) / amount) * 100
        logger.info("%s profit: %.2f%% (buy %s, sell %s)", symbol, profit_pct, buy_dex, sell_dex)

        if profit_pct >= MIN_PROFIT_PCT:
            q1 = await self.get_jupiter_quote(session, USDC_ADDRESS, address, amount)
            if not q1:
                return None
            token_out_jup = int(q1["outAmount"])
            q2 = await self.get_jupiter_quote(session, address, USDC_ADDRESS, token_out_jup)
            if not q2:
                return None
            jup_final = int(q2["outAmount"])
            jup_profit_pct = ((jup_final - amount) / amount) * 100

            cg_price = await self.get_coingecko_price(session, address)
            price_diff_pct = (
                abs(cg_price - buy_price) / buy_price * 100 if cg_price and buy_price else 0
            )

            opp = {
                "symbol": symbol,
                "profit_pct": profit_pct,
                "buy_dex": buy_dex,
                "sell_dex": sell_dex,
                "buy_price": buy_price,
                "sell_price": sell_price,
                "jup_quote": {"usdc_to_token": q1, "token_to_usdc": q2},
                "jup_profit_pct": jup_profit_pct,
                "price_diff_pct": price_diff_pct,
                "cg_price": cg_price,
            }
            logger.info("ARB FOUND: %s %.2f%%", symbol, profit_pct)
            self.notify_telegram(opp)
            return opp
        return None

    # ------------------------------------------------------------------
    # Scan all tokens  (auto-populates if self.tokens empty)
    # ------------------------------------------------------------------
    async def scan(self):
        async with aiohttp.ClientSession() as session:
            if not self.tokens:  # first run or no file
                self.tokens = await self.fetch_trending_solana_mints(session, needed=250)
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
            logger.info("Scan complete – %s opportunities", valid)

    # ------------------------------------------------------------------
    # Telegram notifier
    # ------------------------------------------------------------------
    def notify_telegram(self, opp):
        try:
            msg = f"Arb: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}%\n"
            msg += f"Buy  {opp['buy_dex']}  ${opp['buy_price']:.6f}\n"
            msg += f"Sell {opp['sell_dex']}  ${opp['sell_price']:.6f}\n"
            msg += f"Diff vs CG: {opp['price_diff_pct']:.1f}%"
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg}
            r = requests.get(url, params=payload, timeout=20)
            if r.status_code != 200:
                logger.error("Telegram failed: %s %s", r.status_code, r.text)
            else:
                logger.info("Telegram sent")
        except Exception as e:
            logger.error("Telegram error: %s", e)

# ------------------------------------------------------------------
# Flask routes
# ------------------------------------------------------------------
@app.route("/health")
def health():
    return jsonify({"status": "running"})

@app.route("/test-telegram")
def test_telegram():
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        r = requests.get(url, params={"chat_id": TELEGRAM_CHAT_ID, "text": "Bot online"}, timeout=20)
        return jsonify({"telegram_status": r.status_code})
    except Exception as e:
        return jsonify({"error": str(e)})

# ------------------------------------------------------------------
# Bot loop
# ------------------------------------------------------------------
async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            await detector.scan()
        except Exception as e:
            logger.error("Scan crash: %s", e)
        await asyncio.sleep(POLL_INTERVAL)

# ------------------------------------------------------------------
# Entry-point – threaded Flask + asyncio bot loop
# ------------------------------------------------------------------
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
