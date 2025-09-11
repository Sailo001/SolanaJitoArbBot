// index.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 10000;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

// === Telegram Helper ===
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("❌ Failed to send Telegram message:", err.message);
  }
}

// === Load Raydium Pools ===
async function loadRaydiumPools() {
  const url = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
  try {
    console.log("📡 Fetching Raydium pools...");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Raydium API returned ${res.status}`);
    const data = await res.json();
    return data || [];
  } catch (err) {
    console.error("❌ Failed to load Raydium pools:", err.message);
    return [];
  }
}

// === Scan for Arbitrage (Dummy Mode) ===
async function scanArbitrage() {
  const pools = await loadRaydiumPools();
  if (!pools.length) {
    console.log("⚠️ No pools fetched, skipping scan...");
    return;
  }

  console.log(`✅ Loaded ${pools.length} pools, scanning...`);

  for (const pool of pools.slice(0, 500)) {
    // Dummy arbitrage logic: trigger ~1 in 50 pools
    if (Math.floor(Math.random() * 50) === 0) {
      await sendTelegramMessage(
        `🔔 *Arbitrage Opportunity (Demo)*\nPool: \`${pool.marketId || "unknown"}\``
      );
    }
  }
}

// === Auto Scan Interval ===
setInterval(scanArbitrage, 30_000); // every 30s

// === Express Health Server ===
const app = express();

app.get("/", (req, res) => {
  res.send("✅ Solana Arbitrage Bot is running");
});

// Webhook handler (so bot responds to /start)
app.post(`/webhook/${TELEGRAM_TOKEN}`, express.json(), async (req, res) => {
  const body = req.body;
  if (body?.message?.text === "/start") {
    await sendTelegramMessage("🤖 Bot is online and scanning for arbitrage!");
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});
