// index.js
import fetch from "node-fetch";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "0.5"); // default 0.5%

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in environment variables");
  process.exit(1);
}

// Telegram sender
async function sendTelegramMessage(msg) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg }),
    });
  } catch (err) {
    console.error("⚠️ Telegram send error:", err.message);
  }
}

// ===== Jupiter DEX Price Fetcher =====
async function getDexPrices() {
  const url =
    "https://quote-api.jup.ag/v6/quote" +
    "?inputMint=So11111111111111111111111111111111111111112" + // SOL
    "&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" + // USDC
    "&amount=1000000000&onlyDirectRoutes=true"; // 1 SOL

  try {
    const res = await fetch(url);
    const data = await res.json();

    const prices = {};
    if (data.data) {
      data.data.forEach((route) => {
        const dex = route.marketInfos[0]?.amm.label; // e.g. Raydium, Orca
        const outAmount = parseFloat(route.outAmount) / 1e6; // USDC decimals
        if (dex) {
          if (!prices[dex] || outAmount > prices[dex]) {
            prices[dex] = outAmount; // keep best per-DEX
          }
        }
      });
    }
    return prices;
  } catch (err) {
    console.error("⚠️ Jupiter fetch error", err.message);
    return {};
  }
}

// ===== Arbitrage Scanner =====
async function scanArbitrage() {
  console.log("🔍 Scanning SOL/USDC across DEXs...");
  const prices = await getDexPrices();
  console.log("📊 Prices:", prices);

  const dexNames = Object.keys(prices);
  if (dexNames.length < 2) return; // need at least 2 prices

  const minDex = dexNames.reduce((a, b) =>
    prices[a] < prices[b] ? a : b
  );
  const maxDex = dexNames.reduce((a, b) =>
    prices[a] > prices[b] ? a : b
  );

  const spread = ((prices[maxDex] - prices[minDex]) / prices[minDex]) * 100;
  if (spread > SPREAD_THRESHOLD) {
    const msg =
      `🚨 Arbitrage opportunity!\n\n` +
      `${minDex} → ${maxDex}\n` +
      `Buy @ ${prices[minDex].toFixed(3)} | Sell @ ${prices[maxDex].toFixed(3)}\n` +
      `Spread: ${spread.toFixed(2)}% (Threshold: ${SPREAD_THRESHOLD}%)`;
    console.log(msg);
    await sendTelegramMessage(msg);
  }
}

// Run every 10s
setInterval(scanArbitrage, 10_000);

// ===== Healthcheck HTTP server =====
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Arbitrage bot is running!\n");
  })
  .listen(PORT, () => {
    console.log(`🌍 Healthcheck server listening on port ${PORT}`);
  });

// Startup message
console.log("🤖 Arbitrage bot with Jupiter per-DEX scanning started...");
sendTelegramMessage(
  `✅ Bot deployed with Jupiter per-DEX scanning!\n` +
  `📈 Spread threshold set to ${SPREAD_THRESHOLD}%`
);
