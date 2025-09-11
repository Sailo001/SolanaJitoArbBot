// index.js
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// === CONFIG ===
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RPC_URL = process.env.MEV_RELAY || 'https://api.mainnet-beta.solana.com';

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in environment.");
  process.exit(1);
}

// === WALLET ===
let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
} catch (err) {
  console.error("❌ Wallet error:", err.message);
  process.exit(1);
}

// === SOLANA CONNECTION ===
const connection = new Connection(RPC_URL, "confirmed");
console.log(`✅ Using RPC: ${RPC_URL}`);

// === TELEGRAM HELPERS ===
async function sendTelegram(msg) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
  });
}

// === EXPRESS SERVER ===
const app = express();
app.use(express.json());

// Telegram webhook endpoint
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body?.message?.text;
  const chatId = req.body?.message?.chat?.id;

  if (message === "/start") {
    await sendTelegram("🤖 Bot is live! Scanning will begin shortly...");
  }

  res.sendStatus(200);
});

// Healthcheck
app.get("/", (req, res) => {
  res.send("✅ Bot is running");
});

// === DUMMY SCANNER ===
async function scanLoop() {
  console.log("🔎 Scanning pools (dummy run)...");
  // Later: add real Jupiter + Raydium logic
  await sendTelegram("🔔 Dummy arbitrage opportunity found!");
}

setInterval(scanLoop, 30000);

// === START ===
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
