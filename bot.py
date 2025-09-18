#!/usr/bin/env python3
"""
Solana Cross-DEX Arbitrage Bot - Debug Version
"""
import aiohttp, asyncio, json, os, time, logging
from flask import Flask, jsonify
import threading, requests
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# --------------------------  config  ---------------------------------------- #
SOLANA_RPC = os.getenv("SOLANA_RPC", "https://api.mainnet-beta.solana.com")
MIN_PROFIT_PCT = float(os.getenv("MIN_PROFIT_PCT", "0.3"))
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "30"))
MAX_CONCURRENT = 2

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# DEX APIs
DEX_APIS = {
    "jupiter": "https://quote-api.jup.ag/v6/quote",
    "raydium": "https://quote-api.raydium.io/v6/quote",  # Corrected Raydium endpoint
}

# Focus on high-volume tokens
POPULAR_TOKENS = [
    {"symbol": "SOL", "mint": "So11111111111111111111111111111111111111112", "decimals": 9},
    {"symbol": "USDT", "mint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "decimals": 6},
]

# --------------------------------------------------------------------------- #
@dataclass
class PriceData:
    dex: str
    input_mint: str
    output_mint: str
    in_amount: int
    out_amount: int
    price: float

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

price_cache = MemCache(15)  # Reduced cache time

# --------------------------------------------------------------------------- #
async def get_dex_quote(session: aiohttp.ClientSession, dex: str, input_mint: str, output_mint: str, amount: int) -> Optional[Dict[str, Any]]:
    if input_mint == output_mint:
        return None
        
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount),
        "slippageBps": 50
    }
    
    try:
        async with session.get(DEX_APIS[dex], params=params, timeout=10) as resp:
            if resp.status == 200:
                return await resp.json()
            else:
                logger.warning("%s quote failed: %s - %s", dex.upper(), resp.status, await resp.text())
                return None
    except Exception as e:
        logger.warning("%s quote error: %s", dex.upper(), e)
        return None

# --------------------------------------------------------------------------- #
async def get_dex_price(session: aiohttp.ClientSession, dex: str, input_mint: str, output_mint: str, amount: int) -> Optional[PriceData]:
    cache_key = f"{dex}:{input_mint}:{output_mint}:{amount}"
    cached = price_cache.get(cache_key)
    if cached:
        return cached
        
    quote_data = await get_dex_quote(session, dex, input_mint, output_mint, amount)
    
    if not quote_data or "outAmount" not in quote_data:
        return None
        
    out_amount = int(quote_data["outAmount"])
    price = out_amount / amount if amount > 0 else 0
    
    price_data = PriceData(
        dex=dex,
        input_mint=input_mint,
        output_mint=output_mint,
        in_amount=amount,
        out_amount=out_amount,
        price=price
    )
    
    price_cache.set(cache_key, price_data)
    return price_data

# --------------------------------------------------------------------------- #
async def check_arbitrage(session: aiohttp.ClientSession, token: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    symbol, mint, decimals = token["symbol"], token["mint"], token["decimals"]
    amount = 100 * (10 ** 6)  # Increased to 100 USDC for better visibility
    
    logger.info("Checking %s on both DEXes with %d USDC", symbol, amount // (10 ** 6))
    
    # Get prices from different DEXes
    jupiter_price = await get_dex_price(session, "jupiter", USDC_MINT, mint, amount)
    raydium_price = await get_dex_price(session, "raydium", USDC_MINT, mint, amount)
    
    if not jupiter_price:
        logger.warning("No Jupiter price for %s", symbol)
        return None
        
    if not raydium_price:
        logger.warning("No Raydium price for %s", symbol)
        return None
        
    # Log raw data for debugging
    logger.info("%s - Jupiter: %d USDC → %d tokens (price: %.6f)", 
                symbol, jupiter_price.in_amount, jupiter_price.out_amount, jupiter_price.price)
    logger.info("%s - Raydium: %d USDC → %d tokens (price: %.6f)", 
                symbol, raydium_price.in_amount, raydium_price.out_amount, raydium_price.price)
    
    # Calculate price difference
    price_diff = abs(jupiter_price.price - raydium_price.price)
    min_price = min(jupiter_price.price, raydium_price.price)
    price_diff_pct = (price_diff / min_price) * 100 if min_price > 0 else 0
    
    logger.info("%s - Price difference: %.4f%%", symbol, price_diff_pct)
    
    if price_diff_pct >= MIN_PROFIT_PCT:
        # Determine which DEX has the better price
        if jupiter_price.price > raydium_price.price:
            # Buy on Raydium, sell on Jupiter
            profit = jupiter_price.out_amount - amount
            profit_pct = (profit / amount) * 100
            logger.warning("POTENTIAL ARB: Buy %s on Raydium, sell on Jupiter. Profit: %.2f%%", symbol, profit_pct)
            return {
                "symbol": symbol,
                "mint": mint,
                "buy_dex": "raydium",
                "sell_dex": "jupiter",
                "profit_pct": profit_pct,
                "buy_price": raydium_price.price,
                "sell_price": jupiter_price.price
            }
        else:
            # Buy on Jupiter, sell on Raydium
            profit = raydium_price.out_amount - amount
            profit_pct = (profit / amount) * 100
            logger.warning("POTENTIAL ARB: Buy %s on Jupiter, sell on Raydium. Profit: %.2f%%", symbol, profit_pct)
            return {
                "symbol": symbol,
                "mint": mint,
                "buy_dex": "jupiter",
                "sell_dex": "raydium",
                "profit_pct": profit_pct,
                "buy_price": jupiter_price.price,
                "sell_price": raydium_price.price
            }
    
    logger.info("%s - No arbitrage opportunity (min profit: %.2f%%)", symbol, MIN_PROFIT_PCT)
    return None

# --------------------------------------------------------------------------- #
async def run_arbitrage_check():
    logger.info("Starting detailed arbitrage check")
    opportunities = []
    
    async with aiohttp.ClientSession() as session:
        tasks = [check_arbitrage(session, token) for token in POPULAR_TOKENS]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        for result in results:
            if isinstance(result, Exception):
                logger.error("Error in arbitrage check: %s", result)
            elif result:
                opportunities.append(result)
                logger.warning("ARBITRAGE FOUND: %s - %.2f%%", result["symbol"], result["profit_pct"])
    
    logger.info("Arbitrage check complete. Found %d opportunities.", len(opportunities))
    return opportunities

# --------------------------------------------------------------------------- #
app = Flask(__name__)

@app.route("/")
def home():
    return jsonify({"status": "running", "message": "Solana Arbitrage Bot"})

@app.route("/health")
def health():
    return jsonify(status="running", last_check=time.time())

@app.route("/check-now")
def check_now():
    try:
        opportunities = asyncio.run(run_arbitrage_check())
        return jsonify(status="complete", opportunities=opportunities, count=len(opportunities))
    except Exception as e:
        return jsonify(status="error", message=str(e))

# --------------------------------------------------------------------------- #
def run_bot():
    logger.info("Starting arbitrage bot with detailed logging")
    while True:
        try:
            opportunities = asyncio.run(run_arbitrage_check())
            if opportunities:
                logger.warning("Found %d arbitrage opportunities", len(opportunities))
        except Exception as e:
            logger.error("Error in bot loop: %s", e)
        
        time.sleep(POLL_INTERVAL)

# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    logger.info("Starting detailed arbitrage bot server")
    
    # Start the bot in a separate thread
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
    logger.info("Bot thread started")
    
    # Start the Flask server
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=False, use_reloader=False)
