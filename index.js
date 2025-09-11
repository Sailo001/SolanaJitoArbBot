// index.js
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

// === CONFIG ===
const PORT = process.env.PORT || 10000;
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS) || 30000, 10000);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

// === TELEGRAM HELPER ===
async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    console.error("❌ Failed to send Telegram message:", err.message);
  }
}

// === DUMMY ARBITRAGE SCANNER ===
async function scanArbitrage() {
  console.log("🔎 Scanning for dummy opportunities...");

  // Fake arbitrage opportunity for demo
  const tokens = ["SOL/USDC", "BONK/USDC", "SAMO/USDC", "RAY/USDC"];
  const token = tokens[Math.floor(Math.random() * tokens.length)];
  const spread = (Math.random() * 10).toFixed(2);

  const message = `🔔 Arbitrage Opportunity (Demo)\n\nToken: *${token}*\nSpread: *${spread}%*`;

  console.log(message);

  // Send alert to Telegram
  await sendTelegram(message);
}

// === EXPRESS SERVER (for Render webhook) ===
const app = express();
app.use(express.json());

// Webhook handler for Telegram commands
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const update = req.body;

  if (update.message && update.message.text === "/start") {
    await sendTelegram("🤖 Bot is online and scanning for arbitrage!");
  }

  res.sendStatus(200);
});

// Health endpoint
app.get("/", (req, res) => {
  res.send("✅ Bot is running");
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});

// === STARTUP ===
console.log("🚀 Starting Solana Arbitrage Bot...");
setInterval(scanArbitrage, SCAN_INTERVAL_MS);
