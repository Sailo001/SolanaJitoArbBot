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
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")  # your ID
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "20"))  # seconds
PRICE_DIFF_PCT = float(os.getenv("PRICE_DIFF_PCT", "4.0"))  # e.g. 4%+

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
        tradables = {
            t["symbol"]: t["address"]
            for t in data
            if "verified" in t.get("tags", [])
            and t.get("daily_volume", 0) > 100000
        }
        json.dump(tradables, open(TOKEN_CACHE, "w"), indent=2)
        return tradables
    except Exception as e:
        logging.error(f"Token load failed: {e}")
        return {}

TOKENS = load_tokens()

# === RATE LIMIT ===
RATE_LIMIT = asyncio.Semaphore(1)  # 1 request at a time

async def jupiter_quote(session, input_token, output_token, amount=1_000_000):
    url = f"https://quote-api.jup.ag/v6/quote?inputMint={input_token}&outputMint={output_token}&amount={amount}"
    try:
        async with RATE_LIMIT:
            async with session.get(url, timeout=10) as resp:
                if resp.status == 200:
                    return await resp.json()
    except Exception as e:
        logging.warning(f"Jupiter error {input_token}->{output_token}: {e}")
    return None

async def scan_cycle(session, sym_a, mint_a, sym_b, mint_b):
    # Direct cycle: A -> B -> A
    q1 = await jupiter_quote(session, mint_a, mint_b)
    q2 = await jupiter_quote(session, mint_b, mint_a)

    if q1 and q2:
        in_amt = int(q1.get("inAmount", 0))
        out_amt = int(q2.get("outAmount", 0))
        if in_amt and out_amt:
            diff = (out_amt - in_amt) / in_amt * 100
            if diff >= PRICE_DIFF_PCT:
                msg = f"💹 Arbitrage: {sym_a} → {sym_b} → {sym_a}\nProfit: {diff:.2f}%"
                logging.info(msg)
                send_telegram(msg)

async def run_bot():
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                syms = list(TOKENS.keys())[:20]  # limit (free tier safe)
                tasks = []
                for i in range(len(syms)):
                    for j in range(i + 1, len(syms)):
                        sym_a, sym_b = syms[i], syms[j]
                        mint_a, mint_b = TOKENS[sym_a], TOKENS[sym_b]
                        tasks.append(scan_cycle(session, sym_a, mint_a, sym_b, mint_b))
                await asyncio.gather(*tasks)
                logging.info("Scan complete")
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
    port = int(os.getenv("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
