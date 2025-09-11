// === index.js ===
// Arbitrage Scanner with Batch Rotation (Render-safe)

import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

// === CONFIG ===
const BATCH_SIZE = 100;
const SCAN_INTERVAL = 20_000; // 20s between scans
const PROFIT_THRESHOLD = 0.05; // 5% arbitrage
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const bot = new Telegraf(TG_BOT_TOKEN);

let allTokens = [];
let currentIndex = 0;
let raydiumPools = {};

// === Load Jupiter Tokens ===
async function loadTokens() {
  console.log("📡 Fetching Jupiter token list...");
  const res = await fetch("https://token.jup.ag/all");
  allTokens = await res.json();
  console.log(`✅ Loaded ${allTokens.length} tokens`);
}

// === Get Next Batch ===
function getNextBatch() {
  const batch = allTokens.slice(currentIndex, currentIndex + BATCH_SIZE);
  currentIndex += BATCH_SIZE;
  if (currentIndex >= allTokens.length) currentIndex = 0; // loop back
  return batch;
}

// === Load Raydium Pools ===
async function loadRaydiumPools() {
  console.log("📡 Fetching Raydium pools...");
  const res = await fetch("https://api.raydium.io/v2/sdk/liquidity/mainnet.json");
  raydiumPools = await res.json();
  console.log(`✅ Loaded ${Object.keys(raydiumPools).length} pools`);
}

// === Check Arbitrage ===
async function checkArbitrage(batch) {
  for (const token of batch) {
    try {
      const symbol = token.symbol || token.name;
      const mint = token.address;

      // 1. Get Jupiter price
      const jupRes = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`);
      const jupData = await jupRes.json();
      const jupPrice = jupData.data?.[mint]?.price || null;

      if (!jupPrice) continue;

      // 2. Get Raydium price (find pool with USDC or SOL)
      let rayPrice = null;
      for (const pool of Object.values(raydiumPools)) {
        if (pool.baseMint === mint || pool.quoteMint === mint) {
          // simple price from pool reserves
          if (pool.baseMint === mint) {
            rayPrice = Number(pool.quoteReserve) / Number(pool.baseReserve);
          } else {
            rayPrice = Number(pool.baseReserve) / Number(pool.quoteReserve);
          }
          break;
        }
      }
      if (!rayPrice) continue;

      // 3. Compare prices
      const diff = (jupPrice - rayPrice) / rayPrice;
      if (Math.abs(diff) >= PROFIT_THRESHOLD) {
        const msg = `🚨 Arbitrage Detected!\n\n` +
          `Token: ${symbol}\n` +
          `Mint: ${mint}\n` +
          `Jupiter: $${jupPrice.toFixed(6)}\n` +
          `Raydium: $${rayPrice.toFixed(6)}\n` +
          `Spread: ${(diff * 100).toFixed(2)}%`;

        console.log(msg);
        if (TG_BOT_TOKEN && TG_CHAT_ID) {
          await bot.telegram.sendMessage(TG_CHAT_ID, msg);
        }
      }
    } catch (err) {
      console.error("❌ Error checking token:", err.message);
    }
  }
}

// === Batch Scanner ===
async function scanBatch() {
  const batch = getNextBatch();
  console.log(`🔍 Scanning batch of ${batch.length} tokens...`);
  await checkArbitrage(batch);
}

// === MAIN ===
async function main() {
  await loadTokens();
  await loadRaydiumPools();

  // Scan first batch immediately
  await scanBatch();

  // Rotate every 20s
  setInterval(scanBatch, SCAN_INTERVAL);
}

// === Start ===
main().catch(err => {
  console.error("Fatal error:", err);
});
