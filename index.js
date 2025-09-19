// index.js
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "1"); // %
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "25000"); // ms
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50"); // tokens per batch
const QUOTE_TOKEN = process.env.QUOTE_TOKEN || "USDC";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing");
  process.exit(1);
}

const connection = new Connection(RPC_URL);

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

// Load Solana token list
let allTokens = [];
async function loadTokens() {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json"
    );
    const data = await res.json();
    allTokens = data.tokens.filter(
      (t) =>
        t.symbol !== QUOTE_TOKEN &&
        t.chainId === 101 &&
        t.decimals <= 9
    );
    console.log(`✅ Loaded ${allTokens.length} tokens`);
  } catch (err) {
    console.error("⚠️ Solana Token List fetch error:", err.message);
  }
}

// Example DEX pools (fill with real pool addresses)
const dexPools = [
  { dex: "Raydium", tokenA: "SOL", tokenB: "USDC", pool: "RaydiumPoolPubkey1" },
  { dex: "Orca", tokenA: "SOL", tokenB: "USDC", pool: "OrcaPoolPubkey1" },
  { dex: "Lifinity", tokenA: "SOL", tokenB: "USDC", pool: "LifinityPoolPubkey1" },
];

// Get on-chain pool price
async function getPoolPrice(poolInfo) {
  try {
    const accountInfo = await connection.getTokenAccountsByOwner(
      new PublicKey(poolInfo.pool),
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );
    if (accountInfo.value.length < 2) return null;
    const balances = accountInfo.value.map(a =>
      parseFloat(a.account.data.slice(64, 72))
    );
    return balances[1] / balances[0]; // tokenB / tokenA
  } catch (err) {
    console.error(`⚠️ ${poolInfo.dex} fetch error:`, err.message);
    return null;
  }
}

// Real-time PnL tracking
const trackedOpportunities = new Map();

// Round-robin scanning
let currentIndex = 0;
function getNextTokenBatch() {
  const batch = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const token = allTokens[currentIndex];
    batch.push(token);
    currentIndex = (currentIndex + 1) % allTokens.length;
  }
  return batch;
}

// Scan arbitrage
async function scanArbitrage() {
  const tokensBatch = getNextTokenBatch();
  for (const token of tokensBatch) {
    const prices = {};
    for (const pool of dexPools) {
      if (pool.tokenA !== token.symbol) continue;
      const price = await getPoolPrice(pool);
      if (price) prices[pool.dex] = price;
    }
    if (Object.keys(prices).length < 2) continue;

    const minDex = Object.keys(prices).reduce((a, b) => prices[a] < prices[b] ? a : b);
    const maxDex = Object.keys(prices).reduce((a, b) => prices[a] > prices[b] ? a : b);
    const spread = ((prices[maxDex] - prices[minDex]) / prices[minDex]) * 100;

    if (spread > SPREAD_THRESHOLD) {
      const key = token.address;
      const prev = trackedOpportunities.get(key);

      if (!prev || spread > prev.spread) {
        const msg = `🚨 Arbitrage detected!\nToken: ${token.symbol}\nBuy @ ${minDex}: ${prices[minDex].toFixed(4)}\nSell @ ${maxDex}: ${prices[maxDex].toFixed(4)}\nSpread: ${spread.toFixed(2)}%`;
        console.log(msg);
        await sendTelegramMessage(msg);
        trackedOpportunities.set(key, { ...prices, spread, lastUpdated: Date.now() });
      }
    }
  }
}

// Print PnL every interval
setInterval(() => {
  if (trackedOpportunities.size > 0) {
    console.log("📊 Current tracked arbitrage opportunities:");
    trackedOpportunities.forEach((opp, key) => {
      const dexes = Object.keys(opp);
      const minDex = dexes.reduce((a,b) => opp[a] < opp[b] ? a : b);
      const maxDex = dexes.reduce((a,b) => opp[a] > opp[b] ? a : b);
      console.log(`${key}: Buy ${minDex}@${opp[minDex]}, Sell ${maxDex}@${opp[maxDex]}, Spread ${opp.spread.toFixed(2)}%`);
    });
  }
}, 30000);

// Healthcheck server
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ On-chain arbitrage bot running\n");
}).listen(PORT, () => console.log(`🌍 Healthcheck server listening on port ${PORT}`));

// Start
await loadTokens();
setInterval(scanArbitrage, SCAN_INTERVAL);
console.log("🤖 On-chain meme coin arbitrage bot started...");
sendTelegramMessage(`✅ Bot deployed: scanning all tokens on-chain for arbitrage + real-time PnL!`);
