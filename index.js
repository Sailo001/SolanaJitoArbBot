import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

// === CONFIG ===
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL = 30_000; // 30s

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in environment");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();

let tokens = [];
let pools = [];

// === TELEGRAM START HANDLER ===
bot.start((ctx) => {
  ctx.reply("🤖 Bot is online and scanning for arbitrage!");
});

// === SEND ALERT ===
async function sendTelegram(message) {
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// === LOAD TOKENS ===
async function loadTokens() {
  if (fs.existsSync('./tokens.json')) {
    console.log("📂 Loading tokens.json (local shortlist)...");
    tokens = JSON.parse(fs.readFileSync('./tokens.json', 'utf8'));
    console.log(`✅ Loaded ${tokens.length} tokens from tokens.json`);
  } else {
    console.log("📡 Fetching Jupiter tokens (fallback)...");
    try {
      const res = await fetch('https://token.jup.ag/all');
      tokens = await res.json();
      console.log(`✅ Loaded ${tokens.length} tokens from Jupiter`);
    } catch (err) {
      console.error("❌ Failed to fetch Jupiter tokens:", err.message);
      tokens = [];
    }
  }
}

// === LOAD POOLS ===
async function loadPools() {
  console.log("📡 Fetching Raydium pools...");
  try {
    const res = await fetch("https://api.raydium.io/v2/sdk/liquidity/mainnet.json");
    if (!res.ok) throw new Error(`Raydium returned ${res.status}`);
    pools = await res.json();
    console.log(`✅ Loaded ${Object.keys(pools).length} pools from Raydium`);
  } catch (err) {
    console.error("⚠️ Raydium fetch failed:", err.message);
    pools = {};
  }
}

// === DUMMY ARBITRAGE SCAN (placeholder) ===
async function scanArbitrage() {
  if (!tokens.length || !Object.keys(pools).length) {
    console.log("⚠️ Skipping scan (no tokens/pools)");
    return;
  }

  // ⚡ Demo: always trigger fake opportunity
  const opportunity = {
    token: "RAY/USDC",
    spread: (Math.random() * 5).toFixed(2),
  };

  const msg = `🔔 *Arbitrage Opportunity (Demo)*\n\nToken: ${opportunity.token}\nSpread: ${opportunity.spread}%`;
  console.log(msg);
  await sendTelegram(msg);
}

// === MAIN LOOP ===
async function main() {
  await loadTokens();
  await loadPools();

  setInterval(scanArbitrage, SCAN_INTERVAL);
}

// === EXPRESS SERVER (required by Render) ===
app.get('/', (req, res) => res.send('✅ Solana Arbitrage Bot Running'));
app.listen(PORT, () => console.log(`✅ Server running on http://0.0.0.0:${PORT}`));

// === START BOT ===
bot.launch().then(() => {
  console.log("🤖 Telegram bot launched");
  sendTelegram("🤖 Bot is online and scanning for arbitrage!");
});

// Run main loop
main();
