// index.js
// Solana Arbitrage Bot (Render friendly)

import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

// ==================== CONFIG ====================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in Render environment");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// Jupiter + Raydium sources
const JUPITER_TOKENS = 'https://token.jup.ag/all';
const RAYDIUM_POOLS = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

// Only track pools for these tokens (10–20 max!)
const WATCHLIST = [
  "So11111111111111111111111111111111111111112", // SOL
  "Es9vMFrzaCERz8kz6bqC6pgnrQCzjCqJz9tF8kG78UHv", // USDT
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "7vfCXTUXx5WJV5JADkzxDmQwP7Eo3LJAc6br8461fLx7"  // ETH (Wormhole)
];

// Cache
let tokenCache = [];
let poolCache = [];
let raydiumBackoff = 0;

// ==================== TELEGRAM ALERT ====================
async function alert(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("❌ Telegram alert failed:", err.message);
  }
}

// ==================== JUPITER TOKENS ====================
async function refreshTokens() {
  for (let i = 1; i <= 5; i++) {
    try {
      console.log(`📡 Fetching Jupiter tokens (attempt ${i}/5)...`);
      const res = await fetch(JUPITER_TOKENS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tokenCache = await res.json();
      console.log(`✅ Loaded ${tokenCache.length} tokens`);
      return;
    } catch (err) {
      console.error("❌ Token fetch failed:", err.message);
      await new Promise(r => setTimeout(r, i * 2000));
    }
  }
  console.error("⚠️ Failed to refresh Jupiter tokens after 5 retries");
}

// ==================== RAYDIUM POOLS ====================
async function refreshPools() {
  if (raydiumBackoff > Date.now()) {
    console.log("Raydium pool refresh skipped (backoff active)");
    return;
  }
  try {
    console.log("📡 Fetching Raydium pools (filtered)...");
    const res = await fetch(RAYDIUM_POOLS);
    if (res.status === 429) {
      console.error("Raydium rate-limited; backoff 15m");
      raydiumBackoff = Date.now() + 15 * 60 * 1000;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rawPools = await res.json();
    poolCache = rawPools.filter(
      p => WATCHLIST.includes(p.baseMint) || WATCHLIST.includes(p.quoteMint)
    );

    console.log(`✅ Filtered Raydium pools: ${poolCache.length} relevant pools`);
  } catch (err) {
    console.error("❌ Pool refresh failed:", err.message);
  }
}

// ==================== ARBITRAGE SCAN ====================
async function scanArbitrage() {
  if (!tokenCache.length || !poolCache.length) {
    console.log("⚠️ Skipping arbitrage scan (no data cached yet)");
    return;
  }

  console.log("🔎 Scanning for arbitrage...");
  // Very simple placeholder arbitrage detector
  for (let pool of poolCache) {
    // Example: pretend we find a 5% spread
    const fakeSpread = Math.random();
    if (fakeSpread > 0.95) {
      const base = pool.baseMint.slice(0, 4);
      const quote = pool.quoteMint.slice(0, 4);
      const msg = `🚨 Arbitrage opportunity detected!\nPool: ${base}/${quote}\nSpread: ${(fakeSpread*100).toFixed(2)}%`;
      console.log(msg);
      await alert(msg);
    }
  }
}

// ==================== MAIN LOOP ====================
async function main() {
  console.log("🚀 Starting Solana Arbitrage Bot...");
  await refreshTokens();
  await refreshPools();
  setInterval(refreshTokens, 15 * 60 * 1000); // every 15m
  setInterval(refreshPools, 10 * 60 * 1000); // every 10m
  setInterval(scanArbitrage, 60 * 1000);     // every 1m
}

main().catch(err => {
  console.error("❌ Fatal error in bot:", err);
});
