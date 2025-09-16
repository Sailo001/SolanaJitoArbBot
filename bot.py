# Key improvements to make the bot more effective

# 1. Lower the profit threshold significantly
PRICE_DIFF_PCT = float(os.getenv("PRICE_DIFF_PCT", "0.5"))  # Changed from 4.0%

# 2. Increase polling frequency
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "5"))  # Changed from 20 seconds

# 3. Test with smaller amounts to find more opportunities
async def jupiter_quote(session, input_token, output_token, amount=100_000):  # Changed from 1M
    # ... rest of function stays same

# 4. Include more diverse tokens (modify load_tokens function)
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

# 5. Add multiple trade sizes to test
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

# 6. Focus on stablecoin triangles (more likely to have inefficiencies)
STABLECOINS = ["USDC", "USDT", "DAI", "FRAX", "UST", "MIM"]
MAJOR_TOKENS = ["SOL", "ETH", "BTC", "MSOL", "BONK", "JUP", "WIF"]

async def run_focused_bot():
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
                
                # Major token triangles
                for stable in stable_pairs:
                    for major in major_pairs:
                        if stable[1] and major[1]:
                            tasks.append(check_cycle_multiple_sizes(session, [
                                stable, major, stable
                            ]))
                
                if tasks:
                    await asyncio.gather(*tasks)
                    logging.info(f"Focused scan complete - checked {len(tasks)} opportunities")
                else:
                    logging.warning("No valid token pairs found")
                    
            except Exception as e:
                logging.error(f"Bot error: {e}")
            await asyncio.sleep(POLL_INTERVAL)

# Replace the main run_bot function call with:
# threading.Thread(target=lambda: asyncio.run(run_focused_bot()), daemon=True).start()
