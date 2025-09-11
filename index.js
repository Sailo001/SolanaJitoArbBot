// index.js
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

// === CONFIG ===
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in environment");
  process.exit(1);
}

const SCAN_INTERVAL = 60_000;  // 1 min between scans
const CHUNK_SIZE = 100;        // pools per batch

let poolCache = [];
let currentChunk = 0;

// === TELEGRAM ===
async function sendTelegramMessage(msg) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      })
    });
    if (!res.ok) {
      console.error("❌ Telegram send failed", await res.text());
    }
  } catch (err) {
    console.error("❌ Telegram error:", err);
  }
}

// === RAYDIUM POOLS ===
async function loadRaydiumPools() {
  console.log("📡 Fetching Raydium pools...");
  try {
    const res = await fetch("https://api.raydium.io/v2/sdk/liquidity/mainnet.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    poolCache = Object.values(data).flat();
    console.log(`✅ Loaded ${poolCache.length} pools`);
  } catch (err) {
    console.error("❌ Failed to fetch Raydium pools:", err);
  }
}

// === SCANNER ===
async function scanPoolsChunk() {
  if (!poolCache.length) {
    console.warn("⚠️ No pool cache yet, skipping");
    return;
  }

  const start = currentChunk * CHUNK_SIZE;
  const end = start + CHUNK_SIZE;
  const pools = poolCache.slice(start, end);

  console.log(`🔍 Scanning pools ${start}–${end} of ${poolCache.length}`);

  for (const pool of pools) {
    try {
      // === Dummy arbitrage logic (replace later with real math) ===
      if (Math.random() < 0.001) {
        await sendTelegramMessage(
          `🔔 *Arbitrage Opportunity!*\nPool: \`${pool.marketId || 'unknown'}\``
        );
      }
    } catch (err) {
      console.error("❌ Error scanning pool:", err);
    }
  }

  // Rotate chunk
  currentChunk++;
  if (currentChunk * CHUNK_SIZE >= poolCache.length) {
    currentChunk = 0;
  }
}

// === SERVER ===
const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('✅ Solana Arbitrage Bot is running');
});

// Telegram webhook (optional)
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (message && message.text === '/start') {
      await sendTelegramMessage("🤖 Bot is online and scanning pools!");
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.sendStatus(500);
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
  await loadRaydiumPools();
  setInterval(scanPoolsChunk, SCAN_INTERVAL);
});
