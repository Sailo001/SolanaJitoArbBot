// index.js
import fetch from "node-fetch";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "0.5");
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "20000"); // 20s default
const QUOTE_TOKEN = process.env.QUOTE_TOKEN || "USDC";

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

// ===== Fetch Jupiter token list with retry =====
let seenTokens = new Set();

async function getNewTokens(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch("https://quote-api.jup.ag/v6/tokens");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error("Empty response body");

      const data = JSON.parse(text);

      if (!data.data) throw new Error("Missing data field");

      const tokens = data.data.filter(
        (t) =>
          t.symbol !== QUOTE_TOKEN &&
          !seenTokens.has(t.address) &&
          t.decimals <= 9 // low liquidity / meme coins often have small decimals
      );

      tokens.forEach((t) => seenTokens.add(t.address));
      console.log(`✅ Fetched ${tokens.length} new tokens from Jupiter`);
      return tokens;
    } catch (err) {
      console.error(
        `⚠️ Jupiter token list fetch error (attempt ${i + 1}):`,
        err.message
      );
      await new Promise((r) => setTimeout(r, 2000)); // wait 2s before retry
    }
  }
  console.warn("⚠️ Failed to fetch Jupiter token list after retries");
  return [];
}

// ===== Fetch per-DEX prices from Jupiter =====
async function getDexPrices(inputMint, outputMint) {
  try {
    const url =
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      "&amount=1000000&onlyDirectRoutes=true"; // 1 token
    const res = await fetch(url);
    const data = await res.json();

    const prices = {};
    if (data.data) {
      data.data.forEach((route) => {
        const dex = route.marketInfos[0]?.amm.label;
        const outAmount = parseFloat(route.outAmount) / 1e6; // adjust decimals for USDC
        if (dex) {
          if (!prices[dex] || outAmount > prices[dex]) prices[dex] = outAmount;
        }
      });
    }
    return prices;
  } catch (err) {
    console.error("⚠️ Jupiter quote fetch error", err.message);
    return {};
  }
}

// ===== Arbitrage scanner =====
async function scanArbitrage() {
  const newTokens = await getNewTokens();
  if (newTokens.length === 0) return;

  for (const token of newTokens) {
    const prices = await getDexPrices(
      token.address,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    ); // USDC
    if (Object.keys(prices).length < 2) continue;

    const minDex = Object.keys(prices).reduce((a, b) =>
      prices[a] < prices[b] ? a : b
    );
    const maxDex = Object.keys(prices).reduce((a, b) =>
      prices[a] > prices[b] ? a : b
    );

    const spread = ((prices[maxDex] - prices[minDex]) / prices[minDex]) * 100;
    if (spread > SPREAD_THRESHOLD) {
      const msg =
        `🚨 Arbitrage detected!\n` +
        `Token: ${token.symbol}\n` +
        `${minDex} → ${maxDex}\n` +
        `Buy @ ${prices[minDex].toFixed(4)} | Sell @ ${prices[maxDex].toFixed(
          4
        )}\n` +
        `Spread: ${spread.toFixed(2)}% (Threshold: ${SPREAD_THRESHOLD}%)`;
      console.log(msg);
      await sendTelegramMessage(msg);
    }
  }
}

// Run scanner every SCAN_INTERVAL
setInterval(scanArbitrage, SCAN_INTERVAL);

// ===== Healthcheck server =====
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Arbitrage bot is running!\n");
  })
  .listen(PORT, () => {
    console.log(`🌍 Healthcheck server listening on port ${PORT}`);
  });

console.log("🤖 Meme coin arbitrage bot started...");
sendTelegramMessage(
  `✅ Bot deployed with meme coin arbitrage scanning!\n` +
    `📈 Spread threshold: ${SPREAD_THRESHOLD}% | Scan interval: ${SCAN_INTERVAL}ms`
);
