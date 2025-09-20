// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';
import { Connection, PublicKey } from '@solana/web3.js';
import { createServer } from 'http';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const bot = new Telegraf(TELEGRAM_TOKEN);

const PORT = process.env.PORT || 3000;
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// === HEALTH SERVER ===
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(PORT, () => console.log(`Health check on ${PORT}`));

// === Primary: DEX APIs ===
async function fetchDexTokens() {
  try {
    const res = await fetch("https://quote-api.jup.ag/v6/tokens", { timeout: 5000 });
    if (!res.ok) throw new Error("DEX API failed");
    const tokens = await res.json();
    return tokens;
  } catch (e) {
    console.error("⚠️ DEX API failed, switching to fallback logs:", e.message);
    return null;
  }
}

// === Fallback: On-chain logs ===
async function fetchFromLogs() {
  try {
    const logs = await connection.getSignaturesForAddress(
      new PublicKey("DezXzDX4nd1s8wQyuM2jJm6t9j3oD7kV2d2Y5X3ZyQ4h"), // Example Raydium program
      { limit: 5 }
    );
    return logs;
  } catch (e) {
    console.error("❌ On-chain logs failed:", e.message);
    return [];
  }
}

// === Detection Pipeline ===
async function detectNewTokens() {
  const dexTokens = await fetchDexTokens();

  if (dexTokens) {
    console.log(`✅ Got ${dexTokens.length} tokens from Jupiter API`);
    return;
  }

  // fallback
  const logs = await fetchFromLogs();
  if (logs.length > 0) {
    console.log(`🔍 Fallback detected ${logs.length} events`);
    for (const log of logs) {
      const msg = `🚨 New pool/liquidity event detected (fallback)\nTx: https://solscan.io/tx/${log.signature}`;
      await sendTelegramAlert(msg);
    }
  }
}

// === Telegram Alerts ===
async function sendTelegramAlert(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
    console.log("📩 Alert sent to Telegram");
  } catch (e) {
    console.error("❌ Failed to send Telegram alert:", e.message);
  }
}

// === Run pipeline every 30s ===
setInterval(detectNewTokens, 30000);

console.log("🚀 Bot started with fallback pipeline + Telegram alerts");
