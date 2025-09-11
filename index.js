// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import { createServer } from 'http';

// === CONFIG ===
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS) || 30000, 30000);
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

// === STATE ===
let jupiterTokens = [];
let raydiumPools = {};

// === TELEGRAM ALERT ===
async function sendTelegram(msg) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      }),
    });
  } catch (err) {
    console.error("⚠️ Telegram send failed:", err.message);
  }
}

// === LOADERS WITH RETRY ===
async function loadJupiterTokens(retries = 5, delay = 10000) {
  const url = "https://token.jup.ag/all";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`📡 Fetching Jupiter tokens (attempt ${attempt}/${retries})...`);
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jupiter API error: ${res.status} ${res.statusText}\n${text.slice(0, 200)}...`);
      }
      const data = await res.json();
      jupiterTokens = data;
      console.log(`✅ Loaded ${jupiterTokens.length} tokens`);
      return;
    } catch (err) {
      console.error(`⚠️ Error loading Jupiter tokens: ${err.message}`);
      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error("❌ All retries for Jupiter failed. Exiting.");
        process.exit(1);
      }
    }
  }
}

async function loadRaydiumPools(retries = 5, delay = 10000) {
  const url = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`📡 Fetching Raydium pools (attempt ${attempt}/${retries})...`);
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Raydium API error: ${res.status} ${res.statusText}\n${text.slice(0, 200)}...`);
      }
      const data = await res.json();
      raydiumPools = data;
      console.log(`✅ Loaded ${Object.keys(raydiumPools).length} pools`);
      return;
    } catch (err) {
      console.error(`⚠️ Error loading Raydium pools: ${err.message}`);
      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error("❌ All retries for Raydium failed. Exiting.");
        process.exit(1);
      }
    }
  }
}

// === MOCK PRICE ===
function getPoolPrice(pool) {
  try {
    const baseReserve = Number(pool.baseReserve);
    const quoteReserve = Number(pool.quoteReserve);
    if (!baseReserve || !quoteReserve) return null;
    return quoteReserve / baseReserve;
  } catch {
    return null;
  }
}

// === SCANNER ===
async function scanArbitrage() {
  const pools = Object.values(raydiumPools);
  if (!jupiterTokens.length || !pools.length) {
    console.log("⚠️ Token or pool cache empty, skipping scan");
    return;
  }

  console.log(`🔎 Scanning ${pools.length} pools for opportunities...`);

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const price = getPoolPrice(pool);
    if (!price) continue;

    // Compare with another pool of same token
    const alt = pools.find(p => p.baseMint === pool.baseMint && p.id !== pool.id);
    if (!alt) continue;

    const altPrice = getPoolPrice(alt);
    if (!altPrice) continue;

    const spread = ((altPrice - price) / price) * 100;
    if (Math.abs(spread) > 5) {
      const msg = `💰 *Arbitrage Found!*\nToken: \`${pool.baseMint}\`\nPool1: ${price.toFixed(6)}\nPool2: ${altPrice.toFixed(6)}\nSpread: *${spread.toFixed(2)}%*`;
      console.log(msg);
      await sendTelegram(msg);
    }
  }
}

// === MAIN ===
async function main() {
  await loadJupiterTokens();
  await loadRaydiumPools();
  setInterval(scanArbitrage, SCAN_INTERVAL_MS);
  console.log(`🔁 Auto-scan enabled. Interval ${SCAN_INTERVAL_MS}ms`);

  // Health server
  createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK\n");
  }).listen(PORT, () => console.log(`🌐 Health server on ${PORT}`));
}

main();
