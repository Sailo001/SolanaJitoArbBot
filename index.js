import http from "http";
import fetch from "node-fetch";

console.log("🚀 Starting Solana Arbitrage Scanner...");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID env variables!");
  process.exit(1);
}

console.log("BOT_TOKEN: ✅ Loaded");
console.log("CHAT_ID: ✅ Loaded");

// DEX API endpoints (using USDC/SOL as test pair)
const DEX_APIS = {
  raydium: "https://api.raydium.io/v2/main/price?ids=SOL",
  orca: "https://api.mainnet.orca.so/v1/whirlpool/list",
  lifinity: "https://api.lifinity.io/price",
  meteora: "https://dlmm-api.meteora.ag/pairs"
};

// Fetch price from Raydium
async function getRaydiumPrice() {
  try {
    const res = await fetch(DEX_APIS.raydium);
    const data = await res.json();
    return parseFloat(data["SOL"].price);
  } catch (e) {
    console.error("⚠️ Raydium fetch error", e);
    return null;
  }
}

// Fetch price from Orca
async function getOrcaPrice() {
  try {
    const res = await fetch(DEX_APIS.orca);
    const data = await res.json();
    const solWhirlpool = Object.values(data.whirlpools).find(
      (p) => p.tokenAName === "SOL" && p.tokenBName === "USDC"
    );
    return solWhirlpool ? parseFloat(solWhirlpool.price) : null;
  } catch (e) {
    console.error("⚠️ Orca fetch error", e);
    return null;
  }
}

// Fetch price from Lifinity
async function getLifinityPrice() {
  try {
    const res = await fetch(DEX_APIS.lifinity);
    const data = await res.json();
    return data["SOL/USDC"] ? parseFloat(data["SOL/USDC"]) : null;
  } catch (e) {
    console.error("⚠️ Lifinity fetch error", e);
    return null;
  }
}

// Fetch price from Meteora
async function getMeteoraPrice() {
  try {
    const res = await fetch(DEX_APIS.meteora);
    const data = await res.json();
    const solPair = data.find(
      (p) => p.baseMintSymbol === "SOL" && p.quoteMintSymbol === "USDC"
    );
    return solPair ? parseFloat(solPair.price) : null;
  } catch (e) {
    console.error("⚠️ Meteora fetch error", e);
    return null;
  }
}

// Send Telegram alert
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: CHAT_ID, text };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log("📩 Telegram alert:", data.ok);
  } catch (err) {
    console.error("⚠️ Telegram send error:", err);
  }
}

// Scan for arbitrage
async function scanArbitrage() {
  console.log("🔍 Scanning DEX prices...");

  const [ray, orc, lif, met] = await Promise.all([
    getRaydiumPrice(),
    getOrcaPrice(),
    getLifinityPrice(),
    getMeteoraPrice(),
  ]);

  const prices = { raydium: ray, orca: orc, lifinity: lif, meteora: met };
  console.log("💰 Prices:", prices);

  const validPrices = Object.entries(prices).filter(([, v]) => v !== null);
  if (validPrices.length < 2) return;

  let minDex = validPrices[0];
  let maxDex = validPrices[0];
  for (const [dex, price] of validPrices) {
    if (price < minDex[1]) minDex = [dex, price];
    if (price > maxDex[1]) maxDex = [dex, price];
  }

  const spread = ((maxDex[1] - minDex[1]) / minDex[1]) * 100;
  if (spread >= 5) {
    await sendTelegramMessage(
      `🚨 Arbitrage Opportunity!\n\nBuy on ${minDex[0]} @ $${minDex[1]}\nSell on ${maxDex[0]} @ $${maxDex[1]}\nSpread: ${spread.toFixed(
        2
      )}%`
    );
  } else {
    console.log(`ℹ️ No arbitrage. Spread: ${spread.toFixed(2)}%`);
  }
}

// Run every 30s
setInterval(scanArbitrage, 30_000);

// Healthcheck server
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Arbitrage bot is running!\n");
  })
  .listen(PORT, () => {
    console.log(`🌍 Healthcheck server listening on port ${PORT}`);
  });
