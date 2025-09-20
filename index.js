import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import { Telegraf } from "telegraf";

dotenv.config();

// === CONFIG ===
const PORT = process.env.PORT || 10000;
const SCAN_INTERVAL = 30000; // 30s
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// === EXPRESS HEALTHCHECK ===
const app = express();
app.get("/", (req, res) => res.send("✅ Meme Coin Arb Bot Running..."));
app.listen(PORT, () =>
  console.log(`🌍 Healthcheck server listening on port ${PORT}`)
);

// === HELPERS ===
async function sendAlert(message) {
  try {
    if (!TELEGRAM_CHAT_ID) {
      console.error("❌ TELEGRAM_CHAT_ID not set in .env");
      return;
    }
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
    });
    console.log("📩 Telegram alert sent:", message);
  } catch (err) {
    console.error("❌ Telegram alert failed:", err.message);
  }
}

async function fetchSolanaTokenList() {
  try {
    const url =
      "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json";
    const res = await fetch(url);
    const data = await res.json();
    return data.tokens || [];
  } catch (err) {
    console.error("⚠️ Token list fetch error:", err.message);
    return [];
  }
}

// Simple meme coin filter
function isMemeCoin(token) {
  const lower = (token.name + " " + token.symbol).toLowerCase();
  return (
    lower.includes("doge") ||
    lower.includes("shib") ||
    lower.includes("inu") ||
    lower.includes("cat") ||
    lower.includes("pepe") ||
    lower.includes("moon") ||
    lower.includes("baby") ||
    lower.includes("meme")
  );
}

// === PIPELINE ===
async function runPipeline() {
  console.log("🔄 Running pipeline...");
  const tokens = await fetchSolanaTokenList();

  const memeCoins = tokens.filter(isMemeCoin);

  console.log(`🪙 Found ${memeCoins.length} meme coins`);
  memeCoins.slice(0, 5).forEach((t, i) => {
    console.log(`#${i + 1} ${t.name} (${t.symbol}) - ${t.address}`);
  });

  if (memeCoins.length > 0) {
    const msg = `🚀 Meme coin scan update\n\nFound *${memeCoins.length}* meme coins\n\nTop 3:\n` +
      memeCoins
        .slice(0, 3)
        .map((t, i) => `${i + 1}. *${t.name}* (${t.symbol})\n${t.address}`)
        .join("\n\n");

    await sendAlert(msg);
  }
}

// === START BOT + SCHEDULE ===
bot.launch().then(() => {
  console.log("🤖 Meme Coin Arb Bot started...");
  sendAlert("✅ Meme Coin Arb Bot is live and scanning 🚀");
  setInterval(runPipeline, SCAN_INTERVAL);
});
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ health check route (so Render sees it's alive)
app.get("/", (req, res) => {
  res.send("🚀 Meme Coin Awakener bot running");
});

// ✅ Telegram webhook endpoint
app.post("/webhook", express.json(), (req, res) => {
  // Handle incoming Telegram updates
  console.log("Telegram update:", req.body);
  res.sendStatus(200);
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
