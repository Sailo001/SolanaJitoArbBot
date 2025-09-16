#!/usr/bin/env python3
"""
Solana Arbitrage Opportunity Scanner
Scans Jupiter DEX for triangular arbitrage opportunities
"""

import os
import json
import time
import asyncio
import aiohttp
import logging
import requests
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from datetime import datetime, timedelta
from flask import Flask, jsonify
import threading

# Configuration
class Config:
    TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
    TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID") 
    SCAN_INTERVAL = int(os.getenv("SCAN_INTERVAL", "10"))
    MIN_PROFIT_PCT = float(os.getenv("MIN_PROFIT_PCT", "0.1"))
    MAX_CONCURRENT_REQUESTS = int(os.getenv("MAX_REQUESTS", "20"))
    CACHE_DURATION_HOURS = int(os.getenv("CACHE_HOURS", "12"))
    
    # Jupiter API endpoints
    JUPITER_TOKENS_URL = "https://token.jup.ag/all"
    JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote"
    
    # Token filters
    MIN_DAILY_VOLUME = float(os.getenv("MIN_VOLUME", "50000"))
    TRADE_AMOUNTS = [25000, 100000, 500000, 1000000]  # Different sizes to test

@dataclass
class Token:
    symbol: str
    mint: str
    daily_volume: float
    tags: List[str]

@dataclass
class ArbitrageOpportunity:
    path: List[str]
    profit_pct: float
    trade_size: int
    input_amount: int
    output_amount: int
    timestamp: datetime

class TokenManager:
    def __init__(self):
        self.tokens: Dict[str, Token] = {}
        self.cache_file = "token_cache.json"
        self.last_update = None
    
    async def load_tokens(self) -> Dict[str, Token]:
        """Load and cache token list from Jupiter"""
        if self._is_cache_valid():
            return self._load_from_cache()
            
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(Config.JUPITER_TOKENS_URL, timeout=30) as resp:
                    if resp.status != 200:
                        logging.error(f"Failed to fetch tokens: {resp.status}")
                        return self._load_from_cache()
                    
                    data = await resp.json()
                    tokens = self._filter_tokens(data)
                    self._save_to_cache(tokens)
                    self.tokens = tokens
                    logging.info(f"Loaded {len(tokens)} tokens from Jupiter")
                    return tokens
                    
        except Exception as e:
            logging.error(f"Error loading tokens: {e}")
            return self._load_from_cache()
    
    def _filter_tokens(self, data: List[dict]) -> Dict[str, Token]:
        """Filter tokens based on volume and verification"""
        filtered = {}
        for token_data in data:
            try:
                if (token_data.get("daily_volume", 0) >= Config.MIN_DAILY_VOLUME and
                    "verified" in token_data.get("tags", [])):
                    
                    token = Token(
                        symbol=token_data["symbol"],
                        mint=token_data["address"],
                        daily_volume=token_data.get("daily_volume", 0),
                        tags=token_data.get("tags", [])
                    )
                    filtered[token.symbol] = token
            except KeyError as e:
                logging.warning(f"Skipping malformed token data: {e}")
                continue
                
        return filtered
    
    def _is_cache_valid(self) -> bool:
        """Check if cached data is still valid"""
        if not os.path.exists(self.cache_file):
            return False
        cache_age = time.time() - os.path.getmtime(self.cache_file)
        return cache_age < (Config.CACHE_DURATION_HOURS * 3600)
    
    def _load_from_cache(self) -> Dict[str, Token]:
        """Load tokens from cache file"""
        try:
            if os.path.exists(self.cache_file):
                with open(self.cache_file, 'r') as f:
                    data = json.load(f)
                tokens = {
                    symbol: Token(**token_data) 
                    for symbol, token_data in data.items()
                }
                logging.info(f"Loaded {len(tokens)} tokens from cache")
                return tokens
        except Exception as e:
            logging.error(f"Error loading cache: {e}")
        return {}
    
    def _save_to_cache(self, tokens: Dict[str, Token]):
        """Save tokens to cache file"""
        try:
            data = {
                symbol: {
                    "symbol": token.symbol,
                    "mint": token.mint,
                    "daily_volume": token.daily_volume,
                    "tags": token.tags
                }
                for symbol, token in tokens.items()
            }
            with open(self.cache_file, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logging.error(f"Error saving cache: {e}")

class JupiterAPI:
    def __init__(self):
        self.session = None
        self.semaphore = asyncio.Semaphore(Config.MAX_CONCURRENT_REQUESTS)
    
    async def get_quote(self, input_mint: str, output_mint: str, amount: int) -> Optional[dict]:
        """Get price quote from Jupiter"""
        if not self.session:
            return None
            
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": "50"  # 0.5% slippage
        }
        
        try:
            async with self.semaphore:
                async with self.session.get(Config.JUPITER_QUOTE_URL, 
                                          params=params, 
                                          timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    else:
                        logging.debug(f"Quote failed: {resp.status} for {input_mint[:8]}→{output_mint[:8]}")
        except asyncio.TimeoutError:
            logging.debug(f"Quote timeout: {input_mint[:8]}→{output_mint[:8]}")
        except Exception as e:
            logging.debug(f"Quote error: {e}")
        
        return None

class ArbitrageScanner:
    def __init__(self):
        self.token_manager = TokenManager()
        self.jupiter_api = JupiterAPI()
        self.opportunities: List[ArbitrageOpportunity] = []
        self.total_scans = 0
        self.total_opportunities = 0
    
    async def scan_for_arbitrage(self):
        """Main scanning loop"""
        tokens = await self.token_manager.load_tokens()
        if not tokens:
            logging.error("No tokens loaded, skipping scan")
            return
        
        # Focus on high-volume pairs most likely to have opportunities
        priority_tokens = self._get_priority_tokens(tokens)
        
        async with aiohttp.ClientSession() as session:
            self.jupiter_api.session = session
            
            scan_tasks = []
            
            # Generate trading pairs
            token_pairs = list(priority_tokens.items())
            
            for i in range(len(token_pairs)):
                for j in range(i + 1, min(i + 15, len(token_pairs))):  # Limit combinations
                    token_a = token_pairs[i][1]
                    token_b = token_pairs[j][1]
                    
                    # Test A→B→A cycle
                    scan_tasks.append(
                        self._check_arbitrage_cycle([token_a, token_b, token_a])
                    )
                    
                    # For stablecoins, also test with SOL as intermediate
                    if self._is_stablecoin(token_a) and self._is_stablecoin(token_b):
                        sol_token = tokens.get("SOL")
                        if sol_token:
                            scan_tasks.append(
                                self._check_arbitrage_cycle([token_a, sol_token, token_b, token_a])
                            )
            
            # Execute all scans concurrently
            if scan_tasks:
                await asyncio.gather(*scan_tasks, return_exceptions=True)
                self.total_scans += len(scan_tasks)
                logging.info(f"Completed {len(scan_tasks)} arbitrage checks")
    
    def _get_priority_tokens(self, tokens: Dict[str, Token]) -> Dict[str, Token]:
        """Get tokens most likely to have arbitrage opportunities"""
        # Major stablecoins and high-volume tokens
        priority_symbols = [
            "USDC", "USDT", "SOL", "ETH", "BTC", "MSOL", "JUP", "BONK", 
            "WIF", "POPCAT", "RENDER", "RAY", "ORCA", "MNGO"
        ]
        
        priority = {}
        for symbol in priority_symbols:
            if symbol in tokens:
                priority[symbol] = tokens[symbol]
        
        # Add top 20 by volume that aren't already included
        remaining_tokens = sorted(
            [(k, v) for k, v in tokens.items() if k not in priority],
            key=lambda x: x[1].daily_volume,
            reverse=True
        )[:20]
        
        for symbol, token in remaining_tokens:
            priority[symbol] = token
            
        return priority
    
    def _is_stablecoin(self, token: Token) -> bool:
        """Check if token is a stablecoin"""
        stablecoin_symbols = {"USDC", "USDT", "DAI", "FRAX", "UST", "MIM", "USDH"}
        return token.symbol in stablecoin_symbols
    
    async def _check_arbitrage_cycle(self, path: List[Token]):
        """Check a specific arbitrage cycle"""
        for trade_amount in Config.TRADE_AMOUNTS:
            current_amount = trade_amount
            
            # Execute each leg of the trade
            for i in range(len(path) - 1):
                quote = await self.jupiter_api.get_quote(
                    path[i].mint, 
                    path[i + 1].mint, 
                    current_amount
                )
                
                if not quote or "outAmount" not in quote:
                    return  # Trade path failed
                    
                current_amount = int(quote["outAmount"])
            
            # Calculate profit
            final_amount = current_amount
            profit_pct = ((final_amount - trade_amount) / trade_amount) * 100
            
            if profit_pct >= Config.MIN_PROFIT_PCT:
                opportunity = ArbitrageOpportunity(
                    path=[token.symbol for token in path],
                    profit_pct=profit_pct,
                    trade_size=trade_amount,
                    input_amount=trade_amount,
                    output_amount=final_amount,
                    timestamp=datetime.now()
                )
                
                await self._handle_opportunity(opportunity)
                break  # Found profitable size, no need to test larger amounts
    
    async def _handle_opportunity(self, opportunity: ArbitrageOpportunity):
        """Handle discovered arbitrage opportunity"""
        self.opportunities.append(opportunity)
        self.total_opportunities += 1
        
        # Create alert message
        path_str = " → ".join(opportunity.path)
        message = (
            f"🚨 ARBITRAGE OPPORTUNITY\n"
            f"Path: {path_str}\n" 
            f"Profit: {opportunity.profit_pct:.3f}%\n"
            f"Size: ${opportunity.trade_size:,}\n"
            f"Time: {opportunity.timestamp.strftime('%H:%M:%S')}"
        )
        
        logging.info(message)
        
        # Send Telegram alert
        if Config.TELEGRAM_BOT_TOKEN and Config.TELEGRAM_CHAT_ID:
            await self._send_telegram_alert(message)
    
    async def _send_telegram_alert(self, message: str):
        """Send alert to Telegram"""
        try:
            url = f"https://api.telegram.org/bot{Config.TELEGRAM_BOT_TOKEN}/sendMessage"
            payload = {
                "chat_id": Config.TELEGRAM_CHAT_ID,
                "text": message[:4000],
                "parse_mode": "HTML"
            }
            
            async with aiohttp.ClientSession() as session:
                await session.post(url, json=payload, timeout=10)
                
        except Exception as e:
            logging.error(f"Telegram alert failed: {e}")

# Flask web server for health checks
app = Flask(__name__)
scanner = ArbitrageScanner()

@app.route('/')
def home():
    return jsonify({
        "status": "running",
        "total_scans": scanner.total_scans,
        "opportunities_found": scanner.total_opportunities,
        "last_scan": datetime.now().isoformat()
    })

@app.route('/health')
def health():
    return "OK", 200

@app.route('/opportunities')
def get_opportunities():
    recent_opportunities = [
        {
            "path": opp.path,
            "profit_pct": opp.profit_pct,
            "trade_size": opp.trade_size,
            "timestamp": opp.timestamp.isoformat()
        }
        for opp in scanner.opportunities[-10:]  # Last 10 opportunities
    ]
    return jsonify(recent_opportunities)

async def main_loop():
    """Main scanning loop"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    
    logging.info("Starting Solana Arbitrage Scanner")
    logging.info(f"Min profit threshold: {Config.MIN_PROFIT_PCT}%")
    logging.info(f"Scan interval: {Config.SCAN_INTERVAL}s")
    
    while True:
        try:
            start_time = time.time()
            await scanner.scan_for_arbitrage()
            scan_duration = time.time() - start_time
            
            logging.info(f"Scan completed in {scan_duration:.1f}s")
            
            # Clean up old opportunities (keep last 100)
            if len(scanner.opportunities) > 100:
                scanner.opportunities = scanner.opportunities[-100:]
                
        except Exception as e:
            logging.error(f"Scan error: {e}")
        
        await asyncio.sleep(Config.SCAN_INTERVAL)

def run_scanner():
    """Run the scanner in asyncio loop"""
    asyncio.run(main_loop())

if __name__ == "__main__":
    # Start scanner in background thread
    scanner_thread = threading.Thread(target=run_scanner, daemon=True)
    scanner_thread.start()
    
    # Start Flask server
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
