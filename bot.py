import os
import time
import json
import requests
import asyncio
import aiohttp
import logging
from flask import Flask
import threading

# === LOGGING ===
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

# === ENV VARS ===
TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "5"))  # Reduced from 20
PRICE_DIFF_PCT = float(os.getenv("PRICE_DIFF_PCT", "0.5"))  # Reduced from 4.0

# === TELEGRAM ALERT ===
def send_telegram(msg: str):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        payload = {"chat_id": CHAT_ID, "text": msg[:4000]}
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        logging.error(f"Telegram error: {e}")

# === TOKEN LIST AUTOLOAD ===
TOKEN_CACHE = "tokens.json"

def load_tokens():
    try:
        if os.path.exists(TOKEN_CACHE) and time.time() - os.path.getmtime(TOKEN_CACHE) < 86400:
            return json.load(open(TOKEN_CACHE))
        url = "https://token.jup.ag/all"
        data = requests.get(url, timeout=15).json()
        
        # Include more tokens with lower volume requirements
        tradables = {
            t["symbol"]: t["address"]
            for t in data
            if "verified" in t.get("tags", [])
            and t.get("daily_volume", 0) > 10000  # Lowered from 100k
        }
        
        # Prioritize volatile/newer tokens more likely to have inefficiencies
        volatile_tokens = {
            t["symbol"]: t["address"] 
            for t in data
            if t.get("daily_volume", 0) > 1000
            and len(t.get("tags", [])) < 3  # Less established tokens
        }
        
        # Combine both sets
        tradables.update(volatile_tokens)
        
        json.dump(tradables, open(TOKEN_CACHE, "w"), indent=2)
        return tradables
    except Exception as e:
        logging.error(f"Token load failed: {e}")
        return {}

TOKENS = load_tokens()

# === RATE LIMIT ===
RATE_LIMIT = asyncio.Semaphore(1)

async def jupiter_quote(session, input_token, output_token, amount=100_000):  # Reduced from 1M
    url = f"https://quote-api.jup.ag/v6/quote?inputMint={input_token}&outputMint={output_token}&amount={amount}"
    try:
        async with RATE_LIMIT:
            async with session.get(url, timeout=10) as resp:
                if resp.status == 200:
                    return await resp.json()
    except Exception as e:
        logging.warning(f"Jupiter error {input_token}->{output_token}: {e}")
    return None

async def check_cycle_multiple_sizes(session, path):
    trade_sizes = [10_000, 50_000, 100_000, 500_000]  # Test different sizes
    
    for size in trade_sizes:
        amounts = [size]
        valid = True
        
        for i in range(len(path) - 1):
            q = await jupiter_quote(session, path[i][1], path[i+1][1], amounts[-1])
            if not q or "outAmount" not in q:
                valid = False
                break
            amounts.append(int(q["outAmount"]))
            
        if valid:
            in_amt, out_amt = amounts[0], amounts[-1]
            diff = (out_amt - in_amt) / in_amt * 100
            if diff >= PRICE_DIFF_PCT:
                route = " → ".join([p[0] for p in path])
                msg = f"🔺 Arbitrage: {route}\nSize: ${size:,}\nProfit: {diff:.3f}%"
                logging.info(msg)
                send_telegram(msg)
                return  # Found one, no need to test larger sizes

# Focus on stablecoin triangles (more likely to have inefficiencies)
STABLECOINS = ["USDC", "USDT", "DAI", "FRAX", "UST", "MIM"]
MAJOR_TOKENS = ["SOL", "ETH", "BTC", "MSOL", "BONK", "JUP", "WIF"]

async def run_bot():
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                # Focus on stablecoin triangles first
                stable_pairs = [(s, TOKENS.get(s)) for s in STABLECOINS if s in TOKENS]
                major_pairs = [(t, TOKENS.get(t)) for t in MAJOR_TOKENS if t in TOKENS]
                
                tasks = []
                
                # Stablecoin arbitrage (most likely to succeed)
                for i in range(len(stable_pairs)):
                    for j in range(i + 1, len(stable_pairs)):
                        if stable_pairs[i][1] and stable_pairs[j][1]:
                            tasks.append(check_cycle_multiple_sizes(session, [
                                stable_pairs[i], stable_pairs[j], stable_pairs[i]
                            ]))
                
                # Major token triangles with stablecoins
                for stable in stable_pairs:
                    for major in major_pairs:
                        if stable[1] and major[1]:
                            tasks.append(check_cycle_multiple_sizes(session, [
                                stable, major, stable
                            ]))
                
                # If we have extra capacity, check some general tokens
                if len(tasks) < 20:  # Don't overwhelm the API
                    syms = list(TOKENS.items())[:10]
                    for i in range(len(syms)):
                        for j in range(i + 1, len(syms)):
                            if len(tasks) >= 20:
                                break
                            sym_a, mint_a = syms[i]
                            sym_b, mint_b = syms[j]
                            tasks.append(check_cycle_multiple_sizes(session, [(sym_a, mint_a), (sym_b, mint_b), (sym_a, mint_a)]))
                
                if tasks:
                    await asyncio.gather(*tasks)
                    logging.info(f"Scan complete - checked {len(tasks)} opportunities")
                else:
                    logging.warning("No valid token pairs found")
                    
            except Exception as e:
                logging.error(f"Bot error: {e}")
            await asyncio.sleep(POLL_INTERVAL)

# === FLASK (Render health check) ===
app = Flask(__name__)

@app.route("/")
def home():
    return "Arb bot running ✅"

@app.route("/health")
def health():
    return "ok", 200

def start_loop():
    asyncio.run(run_bot())

if __name__ == "__main__":
    threading.Thread(target=start_loop, daemon=True).start()
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
