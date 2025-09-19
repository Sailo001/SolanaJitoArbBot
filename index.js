// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import { createServer } from 'http';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 10000;

// === TELEGRAM ALERT ===
async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message })
    });
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

// === FETCH RAYDIUM PRICE ===
async function getRaydiumPrice() {
  try {
    const url = "https://api.raydium.io/v2/main/price?ids=sol";
    const res = await fetch(url);
    const data = await res.json();
    return parseFloat(data.sol);
  } catch (err) {
    console.error("Raydium fetch error", err.message);
    return null;
  }
}

// === FETCH JUPITER PRICE ===
async function getJupiterPrice() {
  try {
    const url = "https://price.jup.ag/v4/price?ids=SOL";
    const res = await fetch(url);
    const data = await res.json();
    return parseFloat(data.data.SOL.price);
  } catch (err) {
    console.error("Jupiter fetch error", err.message);
    return null;
  }
}

// === MAIN SCAN LOOP ===
async function scanPrices() {
  console.log("🔍 Scanning SOL prices...");

  const [raydium, jupiter] = await Promise.all([
    getRaydiumPrice(),
    getJupiterPrice()
  ]);

  console.log("Raydium:", raydium, "| Jupiter:", jupiter);

  if (raydium && jupiter) {
    const diff = ((jupiter - raydium) / raydium) * 100;
    if (Math.abs(diff) >= 1) {
      const msg = `🚨 Arbitrage Alert!\nRaydium: $${raydium}\nJupiter: $${jupiter}\nDiff: ${diff.toFixed(2)}%`;
      console.log(msg);
      await sendTelegramMessage(msg);
    }
  }
}

// Run scan every 20s
setInterval(scanPrices, 20000);

// === HEALTH SERVER ===
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});
server.listen(PORT, () => {
  console.log(`🌍 Healthcheck server running on port ${PORT}`);
});

// Start immediately
sendTelegramMessage("✅ SOL price scanner started on Render 🚀");
