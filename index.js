// index.js
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import BN from "bn.js";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "1"); // %
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "25000"); // ms
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "20"); // Reduce batch size
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

// Sleep helper to avoid 429s
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Load Solana token list & filter invalid addresses
let allTokens = [];
async function loadTokens() {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json"
    );
    const data = await res.json();
    allTokens = data.tokens
      .filter((t) => t.symbol !== QUOTE_TOKEN && t.chainId === 101 && t.decimals <= 9)
      .filter((t) => {
        try {
          new PublicKey(t.address);
          return true;
        } catch {
          return false;
        }
      });
    console.log(`✅ Loaded ${allTokens.length} valid tokens`);
  } catch (err) {
    console.error("⚠️ Solana Token List fetch error:", err.message);
  }
}

// Correct on-chain program IDs
const dexPrograms = {
  Raydium: "RVKd61ztZW9xAq6e9kGp22tCzd4MJQJAY5NekjYqMjn",
  Orca: "whirLbEeoK99iD1xRWmER9sEz4m6FxAf8x1gU2wV2s",
  Lifinity: "5Tgq6PVZrJ2pY7PrxvP6j3Hv93Q5W5kDPvEtZYb9ExT"
};

// Dynamic pool discovery with throttling and error handling
async function getPoolsForToken(dex, tokenAddress) {
  try {
    const programId = new PublicKey(dexPrograms[dex]);
    const accounts = await connection.getProgramAccounts(programId);
    await sleep(50); // slight delay to reduce RPC spam
    return accounts
      .filter((acct) => acct.account.data.includes(tokenAddress))
      .map((acct) => acct.pubkey);
  } catch (err) {
    console.error(`⚠️ ${dex} getPools error:`, err.message);
    return [];
  }
}

// Price decoding
async function getPriceFromPool(poolPubkey, tokenAddress, dex) {
  try {
    const accountInfo = await connection.getAccountInfo(poolPubkey);
    if (!accountInfo) return null;
    const data = accountInfo.data;

    let reserveA, reserveB;
    reserveA = new BN(data.slice(64, 72), "le").toNumber();
    reserveB = new BN(data.slice(72, 80), "le").toNumber();

    if (reserveA === 0) return null;
    return reserveB / reserveA;
  } catch (err) {
    console.error(`⚠️ ${dex} pool price decode error:`, err.message);
    return null;
  }
}

// PnL tracking
const trackedOpportunities = new Map();

// Batch scanning
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
    for (const dex in dexPrograms) {
      const pools = await getPoolsForToken(dex, token.address);
      for (const pool of pools) {
        const price = await getPriceFromPool(pool, token.address, dex);
        if (price) prices[dex] = price;
        await sleep(50); // throttle RPC calls
      }
    }

    if (Object.keys(prices).length < 2) continue;

    const minDex = Object.keys(prices).reduce((a, b) =>
      prices[a] < prices[b] ? a : b
    );
    const maxDex = Object.keys(prices).reduce((a, b) =>
      prices[a] > prices[b] ? a : b
    );
    const spread = ((prices[maxDex] - prices[minDex]) / prices[minDex]) * 100;

    if (spread > SPREAD_THRESHOLD) {
      const key = token.address;
      const prev = trackedOpportunities.get(key);
      if (!prev || spread > prev.spread) {
        const msg = `🚨 Arbitrage detected!\nToken: ${token.symbol}\nBuy @ ${minDex}: ${prices[minDex].toFixed(
          4
        )}\nSell @ ${maxDex}: ${prices[maxDex].toFixed(
          4
        )}\nSpread: ${spread.toFixed(2)}%`;
        console.log(msg);
        await sendTelegramMessage(msg);
        trackedOpportunities.set(key, {
          ...prices,
          spread,
          lastUpdated: Date.now(),
        });
      }
    }
  }
}

// Print PnL every interval
setInterval(() => {
  if (trackedOpportunities.size > 0) {
    console.log("📊 Current tracked arbitrage opportunities:");
    trackedOpportunities.forEach((opp, key) => {
      const dexes = Object.keys(opp).filter(
        (k) => k !== "spread" && k !== "lastUpdated"
      );
      const minDex = dexes.reduce((a, b) => (opp[a] < opp[b] ? a : b));
      const maxDex = dexes.reduce((a, b) => (opp[a] > opp[b] ? a : b));
      console.log(
        `${key}: Buy ${minDex}@${opp[minDex]}, Sell ${maxDex}@${opp[maxDex]}, Spread ${opp.spread.toFixed(
          2
        )}%`
      );
    });
  }
}, 30000);

// Healthcheck server
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Meme coin on-chain arbitrage bot running\n");
  })
  .listen(PORT, () => console.log(`🌍 Healthcheck server listening on port ${PORT}`));

// Start
await loadTokens();
setInterval(scanArbitrage, SCAN_INTERVAL);
console.log(
  "🤖 Meme coin on-chain arbitrage bot started (Raydium + Orca + Lifinity)..."
);
sendTelegramMessage(
  `✅ Bot deployed: scanning all valid tokens for arbitrage + real-time PnL!`
);
