// index.js
// Meme Coin Arbitrage Bot with Filter + Logging

import express from "express";
import fetch from "node-fetch";

// === Step 1: Fetch Solana Token List ===
const TOKEN_LIST_URL =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json";

async function fetchTokenList() {
  try {
    const res = await fetch(TOKEN_LIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.tokens || [];
  } catch (err) {
    console.error("⚠️ Token list fetch error:", err.message);
    return [];
  }
}

// === Step 2: Filter Meme Coins (expanded) ===
function filterMemeCoins(tokens) {
  const memeKeywords = [
    "dog", "pepe", "moon", "cat", "elon", "shib", "frog",
    "baby", "bonk", "meme", "inu", "pump", "lambo"
  ];

  return tokens.filter(t => {
    const name = (t.name || "").toLowerCase();
    const symbol = (t.symbol || "").toLowerCase();
    return memeKeywords.some(k => name.includes(k) || symbol.includes(k));
  });
}

// === Step 3: Run Pipeline ===
async function runPipeline() {
  console.log("🔄 Running pipeline...");

  const tokens = await fetchTokenList();
  const memeCoins = filterMemeCoins(tokens);

  console.log(`🪙 Found ${memeCoins.length} meme coins`);

  // 👀 Show a sample of the first 5 tokens
  memeCoins.slice(0, 5).forEach((coin, i) => {
    console.log(
      `#${i + 1} ${coin.name} (${coin.symbol}) - Address: ${coin.address}`
    );
  });

  return memeCoins;
}

// === Step 4: Schedule Pipeline ===
setInterval(runPipeline, 30_000); // every 30s
runPipeline();

// === Step 5: Healthcheck Server ===
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("🤖 Meme coin arbitrage bot running..."));
app.listen(PORT, () =>
  console.log(`🌍 Healthcheck server listening on port ${PORT}`)
);
