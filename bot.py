#!/usr/bin/env python3
"""
Solana inter-DEX arbitrage scanner (Raydium ⇄ Orca)
Uses DexScreener API for pool data with proper error handling and fallbacks.
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
# Config
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
MAX_CONCURRENT_REQUESTS = 5
BATCH_DELAY = 2.0

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------
USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
RAYDIUM_PROGRAM = Pubkey.from_string("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
ORCA_PROGRAM = Pubkey.from_string("9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP")
DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex"

# ------------------------------------------------------------------
# CoinGecko ID map
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

    def load_tokens(self):
        """Load tokens from file or initialize empty dict."""
        if os.path.isfile(TOKEN_FILE):
            with open(TOKEN_FILE) as f:
                self.tokens = json.load(f)
                logger.info("Loaded %s tokens from %s", len(self.tokens), TOKEN_FILE)
        else:
            logger.info("No %s found - will pull pool list from DexScreener", TOKEN_FILE)
            self.tokens = {}

    async def fetch_dexscreener_pools(self, session: aiohttp.ClientSession, needed: int = 300) -> dict:
        """Fetch liquid USDC-paired pools from DexScreener API with proper error handling."""
        url = f"{DEXSCREENER_URL}/search"
        params = {"q": "solana", "limit": 100}  # Start with a reasonable limit
        
        out = {}
        page = 1
        retries = 3
        
        for attempt in range(retries):
            try:
                async with session.get(url, params=params, timeout=15) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        pairs = data.get("pairs", [])
                        
                        if not pairs:
                            logger.warning("No pairs found in DexScreener response")
                            return {}
                        
                        for pair in pairs:
                            try:
                                # Check if it's a USDC pair with sufficient liquidity
                                if (pair.get("quoteToken", {}).get("address") == USDC_ADDRESS and
                                    pair.get("liquidity", {}).get("usd", 0) > 2000):  # $2k min liquidity
                                    
                                    base_token = pair.get("baseToken", {})
                                    mint = base_token.get("address")
                                    symbol = base_token.get("symbol", "UNKNOWN")
                                    
                                    # Validate the mint address
                                    Pubkey.from_string(mint)
                                    
                                    out[symbol] = {
                                        "address": mint,
                                        "liquidity": pair.get("liquidity", {}).get("usd", 0)
                                    }
                                    
                                    if len(out) >= needed:
                                        break
                            except Exception as e:
                                logger.debug("Invalid token in pair: %s", e)
                                continue
                        
                        logger.info("Fetched %s pools from DexScreener API", len(out))
                        return out
                    elif resp.status == 429:
                        # Rate limited - wait and retry
                        wait_time = 2 ** attempt * 5
                        logger.warning("DexScreener rate limited. Waiting %s seconds", wait_time)
                        await asyncio.sleep(wait_time)
                        continue
                    else:
                        logger.error("DexScreener API error: %s", resp.status)
                        return {}
            except asyncio.TimeoutError:
                logger.warning("DexScreener timeout (attempt %s)", attempt + 1)
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt * 3)
            except Exception as e:
                logger.error("Failed to fetch DexScreener pools: %s", e)
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt * 3)
        
        return out

    async def get_raydium_pool_price(self, token_address: str) -> float:
        """Fetch Raydium pool price from on-chain data."""
        try:
            token_mint = Pubkey.from_string(token_address)
            usdc_mint = Pubkey.from_string(USDC_ADDRESS)
            mint_a, mint_b = (token_mint, usdc_mint) if token_mint < usdc_mint else (usdc_mint, token_mint)
            pool_addr = Pubkey.find_program_address([b"amm", bytes(mint_a), bytes(mint_b)], RAYDIUM_PROGRAM)[0]

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
            logger.error("Raydium price error for %s: %s", token_address, e)
            return None

    async def get_orca_pool_price(self, token_address: str) -> float:
        """Fetch Orca pool price from on-chain data."""
        try:
            token_mint = Pubkey.from_string(token_address)
            usdc_mint = Pubkey.from_string(USDC_ADDRESS)
            mint_a, mint_b = (token_mint, usdc_mint) if token_mint < usdc_mint else (usdc_mint, token_mint)
            pool_addr = Pubkey.find_program_address([b"whirlpool", bytes(mint_a), bytes(mint_b), b"\x0b\xb8"], ORCA_PROGRAM)[0]

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
            logger.error("Orca price error for %s: %s", token_address, e)
            return None

    async def get_jupiter_quote(self, session: aiohttp.ClientSession, input_mint: str, output_mint: str, amount: int):
        """Fetch quote from Jupiter Aggregator."""
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
        try:
            async with session.get(JUPITER_URL, params=params, timeout=10) as resp:
                if resp.status == 200:
                    return await resp.json()
                elif resp.status == 400:
                    self.invalid_tokens[pair] = time.time()
                    return None
                else:
                    logger.warning("Jupiter quote error: %s", resp.status)
                    return None
        except Exception as e:
            logger.error("Jupiter quote failed: %s", e)
            return None

    async def detect_arb(self, session: aiohttp.ClientSession, symbol: str, address: str, amount=100_000_000):
        """Detect arbitrage opportunity for a token."""
        if address == USDC_ADDRESS:
            return None
        logger.info("Checking arb for %s", symbol)

        ray_price = await self.get_raydium_pool_price(address)
        orca_price = await self.get_orca_pool_price(address)
        if ray_price is None or orca_price is None:
            return None

        buy_dex, sell_dex = ("Raydium", "Orca") if ray_price < orca_price else ("Orca", "Raydium")
        buy_price, sell_price = min(ray_price, orca_price), max(ray_price, orca_price)
        profit_pct = ((sell_price - buy_price) / buy_price) * 100
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

            opp = {
                "symbol": symbol,
                "profit_pct": profit_pct,
                "buy_dex": buy_dex,
                "sell_dex": sell_dex,
                "buy_price": buy_price,
                "sell_price": sell_price,
                "jup_profit_pct": jup_profit_pct,
            }
            logger.info("ARB FOUND: %s %.2f%%", symbol, profit_pct)
            self.notify_telegram(opp)
            return opp
        return None

    async def scan(self):
        """Scan all tokens for arbitrage opportunities."""
        async with aiohttp.ClientSession() as session:
            if not self.tokens:
                self.tokens = await self.fetch_dexscreener_pools(session, needed=100)  # Reduced for stability
                if not self.tokens:
                    logger.error("No tokens fetched - using fallback tokens")
                    # Fallback to some known tokens
                    self.tokens = {
                        "BONK": {"address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"},
                        "WIF": {"address": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"},
                        "POPCAT": {"address": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"},
                    }

            logger.info("Scanning %s tokens", len(self.tokens))
            tasks = [
                self.detect_arb(session, sym, info["address"])
                for sym, info in self.tokens.items()
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            opportunities = [r for r in results if isinstance(r, dict)]
            logger.info("Scan complete - %s opportunities", len(opportunities))

    def notify_telegram(self, opp):
        """Send notification via Telegram."""
        if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
            return
        try:
            msg = (
                f"🚀 Arb Opportunity: {opp['symbol']}\n"
                f"Profit: {opp['profit_pct']:.2f}%\n"
                f"Buy at {opp['buy_dex']}: ${opp['buy_price']:.6f}\n"
                f"Sell at {opp['sell_dex']}: ${opp['sell_price']:.6f}\n"
                f"Jupiter Profit: {opp['jup_profit_pct']:.2f}%"
            )
            url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
            payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg}
            requests.post(url, json=payload, timeout=10)
        except Exception as e:
            logger.error("Telegram notification failed: %s", e)

# ------------------------------------------------------------------
# Flask routes
# ------------------------------------------------------------------
@app.route("/health")
def health():
    return jsonify({"status": "healthy"})

@app.route("/test-telegram")
def test_telegram():
    if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": "Bot is operational"}
        try:
            requests.post(url, json=payload, timeout=10)
            return jsonify({"status": "message sent"})
        except Exception as e:
            return jsonify({"error": str(e)})
    return jsonify({"error": "Telegram not configured"})

# ------------------------------------------------------------------
# Main loop
# ------------------------------------------------------------------
async def run_bot():
    detector = ArbDetector()
    while True:
        try:
            await detector.scan()
        except Exception as e:
            logger.error("Scan error: %s", e)
        await asyncio.sleep(POLL_INTERVAL)

async def main():
    import threading
    flask_thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=8080, debug=False),
        daemon=True,
    )
    flask_thread.start()
    await run_bot()

if __name__ == "__main__":
    asyncio.run(main())
