import aiohttp
import asyncio
import json
import os
import time
from datetime import datetime
from flask import Flask, jsonify
import threading
import requests  # For Telegram

app = Flask(__name__)

# Config (set as env vars on Render)
RPC_URL = os.getenv('SOLANA_RPC', 'https://api.mainnet-beta.solana.com')  # Replace with your RPC
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN', 'your_bot_token')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', 'your_chat_id')
TOKEN_FILE = 'tokens.json'  # Upload this file
MIN_PROFIT_PCT = 1.0  # Minimum profit threshold
SLIPPAGE_BPS = 50  # 0.5%
POLL_INTERVAL = 10  # Seconds

SOL_ADDRESS = 'So11111111111111111111111111111111111111112'
USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
JUPITER_URL = "https://quote-api.jup.ag/v6/quote"
RAYDIUM_URL = "https://api.raydium.io/v2/main/price"

class ArbDetector:
    def __init__(self):
        with open(TOKEN_FILE, 'r') as f:
            self.tokens = json.load(f)  # { "symbol": {"address": "..."} }

    async def get_quote(self, session, input_mint, output_mint, amount):
        params = {
            'inputMint': input_mint,
            'outputMint': output_mint,
            'amount': str(amount),
            'slippageBps': SLIPPAGE_BPS
        }
        async with session.get(JUPITER_URL, params=params) as resp:
            if resp.status == 200:
                return await resp.json()
            return None

    async def get_raydium_price(self, session, token_address):
        async with session.get(RAYDIUM_URL) as resp:
            if resp.status == 200:
                prices = await resp.json()
                return prices.get(token_address)
            return None

    async def detect_arb(self, session, symbol, address, amount=1000000):  # 1 USDC
        # Triangular arb: USDC -> Token -> SOL -> USDC
        quote1 = await self.get_quote(session, USDC_ADDRESS, address, amount)  # USDC to Token
        if not quote1:
            return None
        token_out = int(quote1['outAmount'])

        quote2 = await self.get_quote(session, address, SOL_ADDRESS, token_out)  # Token to SOL
        if not quote2:
            return None
        sol_out = int(quote2['outAmount'])

        quote3 = await self.get_quote(session, SOL_ADDRESS, USDC_ADDRESS, sol_out)  # SOL to USDC
        if not quote3:
            return None
        final_usdc = int(quote3['outAmount'])

        profit_pct = ((final_usdc - amount) / amount) * 100
        if profit_pct > MIN_PROFIT_PCT:
            # Check Raydium direct price for validation (mispricing)
            ray_price = await self.get_raydium_price(session, address)
            if ray_price:
                jup_price = (amount / token_out) if token_out else 0  # Approx price from quote
                if abs(ray_price - jup_price) / jup_price > 0.01:  # 1% diff
                    return {
                        'symbol': symbol,
                        'profit_pct': profit_pct,
                        'jup_quote': quote1,  # For manual execution
                        'ray_price': ray_price
                    }
        return None

    async def scan(self):
        async with aiohttp.ClientSession() as session:
            tasks = [self.detect_arb(session, sym, info['address']) for sym, info in self.tokens.items()]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, dict):
                    self.notify_telegram(result)

    def notify_telegram(self, opp):
        msg = f"Arb Opportunity: {opp['symbol']} | Profit: {opp['profit_pct']:.2f}% | Time: {datetime.now()}\nQuote: {json.dumps(opp['jup_quote'], indent=2)}\nFor MEV protection, execute as Jito bundle: https://jito.wtf/docs/bundles"
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage?chat_id={TELEGRAM_CHAT_ID}&text={msg}"
        requests.get(url)

async def run_bot():
    detector = ArbDetector()
    while True:
        await detector.scan()
        await asyncio.sleep(POLL_INTERVAL)

# Flask endpoints to make it a web service
@app.route('/health')
def health():
    return jsonify({'status': 'running'})

if __name__ == '__main__':
    # Run bot in thread
    threading.Thread(target=asyncio.run, args=(run_bot(),)).start()
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
