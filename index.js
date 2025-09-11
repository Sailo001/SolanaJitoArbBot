import 'dotenv/config';
import fetch from 'node-fetch';
import { createServer } from 'http';

// === ENV VARS ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in Render Environment");
  process.exit(1);
}

const MEV_RELAY = "https://api.mainnet-beta.solana.com";
const SCAN_INTERVAL = 30_000; // 30s

let cachedTokens = [];
let cachedPools = [];

// === TELEGRAM ALERT ===
async function sendTelegram(msg) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg }),
    });
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// === FETCH TOKENS FROM JUPITER ===
async function loadTokens() {
  console.log("📡 Fetching Jupiter tokens...");
  try {
    const res = await fetch("https://token.jup.ag/all");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tokens = await res.json();

    // Filter to a manageable subset (first 100 for now)
    cachedTokens = tokens.slice(0, 100);
    console.log(`✅ Loaded ${cachedTokens.length} tokens`);
  } catch (err) {
    console.error("❌ Failed to load tokens:", err.message);
  }
}

// === FETCH RAYDIUM POOLS (FILTERED) ===
async function loadRaydiumPools() {
  console.log("📡 Fetching Raydium pools (filtered)...");
  try {
    const res = await fetch("https://api.raydium.io/v2/sdk/liquidity/mainnet.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pools = await res.json();

    // Filter: keep only pools with our cached tokens
    const tokenMints = new Set(cachedTokens.map(t => t.address));
    cachedPools = Object.values(pools).filter(pool =>
      tokenMints.has(pool.baseMint) || tokenMints.has(pool.quoteMint)
    );

    console.log(`✅ Loaded ${cachedPools.length} filtered pools`);
  } catch (err) {
    console.error("⚠️ Failed to load Raydium pools:", err.message);
  }
}

// === ARBITRAGE SCAN (stub logic for now) ===
async function scanArbitrage() {
  if (!cachedTokens.length || !cachedPools.length) {
    console.log("⚠️ Token or pool cache empty, skipping scan");
    await sendTelegram("⚠️ Skipping scan — no tokens/pools loaded yet.");
    return;
  }

  const msg = `🔎 Scan complete:\n- ${cachedTokens.length} tokens\n- ${cachedPools.length} pools\n(no arbitrage logic yet 🚧)`;
  console.log(msg);
  await sendTelegram(msg);
}

// === HEALTH SERVER (Render needs a port) ===
const PORT = process.env.PORT || 10000;
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Bot is running\n");
}).listen(PORT, () => {
  console.log(`🌐 Health server listening on ${PORT}`);
});

// === MAIN LOOP ===
async function main() {
  console.log(`✅ Using MEV_RELAY: ${MEV_RELAY}`);
  console.log("🚀 Starting Solana Arbitrage Bot...");

  await loadTokens();
  await loadRaydiumPools();

  setInterval(scanArbitrage, SCAN_INTERVAL);
}

main();
