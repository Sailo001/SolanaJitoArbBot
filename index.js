// index.js
import http from "http";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 10000;

// === Healthcheck server ===
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Arbitrage bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});

// === Telegram notifier ===
async function sendTelegramAlert(msg) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg }),
    });
    const data = await res.json();
    console.log("📩 Telegram response:", data);
  } catch (err) {
    console.error("⚠️ Telegram error:", err);
  }
}

// === Token list ===
const TOKENS = [
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { symbol: "BONK", mint: "DezXzjJZ5Xykq9gX6i7nJQKzG4kY5LR9pZ5iG84RkX3E" },
  { symbol: "SAMO", mint: "7xKXtg2CW87d97TXJSDpbD5KkRGNuG8j8pBSEm5tChsM" },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59sCz5iM6bhXfj4w" }
];
let currentIndex = 0;

// === Real price fetchers ===
async function getRaydiumPrice(mint) {
  try {
    const url = `https://api.raydium.io/v2/main/pairs`;
    const res = await fetch(url);
    const data = await res.json();
    const pool = data.find(p => p.baseMint === mint && p.quoteMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
    return pool ? Number(pool.price) : null;
  } catch (err) {
    console.error("⚠️ Raydium fetch error", err);
    return null;
  }
}

async function getOrcaPrice(mint) {
  try {
    const url = `https://api.orca.so/allPools`;
    const res = await fetch(url);
    const data = await res.json();
    const pool = Object.values(data.pools).find(
      p => p.tokenA.mint === mint && p.tokenB.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    return pool ? Number(pool.tokenAPrice) : null;
  } catch (err) {
    console.error("⚠️ Orca fetch error", err);
    return null;
  }
}

async function getLifinityPrice(mint) {
  try {
    const url = `https://api.lifinity.io/pools`;
    const res = await fetch(url);
    const data = await res.json();
    const pool = data.find(
      p => (p.mintA === mint && p.mintB === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") ||
           (p.mintB === mint && p.mintA === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    );
    return pool ? Number(pool.price) : null;
  } catch (err) {
    console.error("⚠️ Lifinity fetch error", err);
    return null;
  }
}

async function getMeteoraPrice(mint) {
  try {
    const url = `https://dlmm-api.meteora.ag/pairs`;
    const res = await fetch(url);
    const data = await res.json();
    const pool = data.find(
      p => (p.baseMint === mint && p.quoteMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") ||
           (p.quoteMint === mint && p.baseMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    );
    return pool ? Number(pool.price) : null;
  } catch (err) {
    console.error("⚠️ Meteora fetch error", err);
    return null;
  }
}

// === Arbitrage scanner ===
async function scanArbitrage() {
  try {
    const token = TOKENS[currentIndex];
    console.log(`🔍 Scanning ${token.symbol}/USDC across DEXs...`);

    // rotate for next run
    currentIndex = (currentIndex + 1) % TOKENS.length;

    const [raydium, orca, lifinity, meteora] = await Promise.all([
      getRaydiumPrice(token.mint),
      getOrcaPrice(token.mint),
      getLifinityPrice(token.mint),
      getMeteoraPrice(token.mint),
    ]);

    const prices = { Raydium: raydium, Orca: orca, Lifinity: lifinity, Meteora: meteora };
    console.log("📊 Prices:", prices);

    const validPrices = Object.entries(prices).filter(([, p]) => p);
    if (validPrices.length >= 2) {
      const minPrice = Math.min(...validPrices.map(([, p]) => p));
      const maxPrice = Math.max(...validPrices.map(([, p]) => p));
      const spread = ((maxPrice - minPrice) / minPrice) * 100;

      if (spread >= 5) {
        await sendTelegramAlert(
          `🚨 Arbitrage detected on ${token.symbol}/USDC!\n\n` +
          `Lowest: $${minPrice.toFixed(4)}\n` +
          `Highest: $${maxPrice.toFixed(4)}\n` +
          `Spread: ${spread.toFixed(2)}%`
        );
      }
    }
  } catch (err) {
    console.error("⚠️ scanArbitrage error", err);
  }
}

// === Start ===
console.log("🤖 Arbitrage bot started...");
setInterval(scanArbitrage, 20000); // scan every 20s
