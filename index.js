// index.js
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import BN from "bn.js";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = (process.env.RPC_URL || "https://solana-api.projectserum.com").trim();
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "2"); // %
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "25000"); // ms
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "20");
const QUOTE_TOKEN = process.env.QUOTE_TOKEN || "USDC";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing");
  process.exit(1);
}

const connection = new Connection(RPC_URL, "confirmed");
const USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ----------------------  TELEGRAM  ----------------------
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ----------------------  TOKEN LIST  ----------------------
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

// ----------------------  CORRECT PROGRAM IDs  ----------------------
const dexPrograms = {
  Raydium: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",   // AMM v4
  Orca:    "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",   // Whirlpool
  // Lifinity removed – invalid key
};

// ----------------------  ONE-SHOT POOL CACHE  ----------------------
const poolCache = new Map(); // baseMint -> {dex, price, ...}

async function buildPoolCache() {
  // 1️⃣  Raydium SDK liquidity file (live, no key, 1 000+ USDC pools)
  const SDK_URL = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
  try {
    const res = await fetch(SDK_URL, { timeout: 15000 });
    if (res.ok) {
      const data = await res.json();
      for (const pool of [...data.official, ...data.unOfficial]) {
        if (pool.quoteMint !== USDC_ADDRESS) continue;
        const mint = pool.baseMint;
        const symbol = pool.symbol || "UNKNOWN";
        try {
          new PublicKey(mint);
          const price = parseFloat(pool.price) || 0;
          if (price === 0) continue;
          poolCache.set(mint, {
            dex: "Raydium",
            baseMint: mint,
            quoteMint: USDC_ADDRESS,
            price,
          });
        } catch {
          continue;
        }
      }
      console.log(`Loaded ${poolCache.size} pools from SDK JSON`);
      return;
    }
  } catch (e) {
    console.warn("SDK liquidity file failed:", e.message);
  }

  // 2️⃣  Fallback – DexScreener pages (kept for safety)
  let page = 1;
  while (poolCache.size < 200) {
    const url = `https://api.dexscreener.com/latest/dex/search?q=solana&page=${page}`;
    try {
      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) break;
      const data = await res.json();
      const pairs = data.pairs || [];
      if (!pairs.length) break;
      for (const p of pairs) {
        const mint = p.baseToken.address;
        const symbol = p.baseToken.symbol;
        if (mint.toLowerCase() === "solana") continue;
        try {
          new PublicKey(mint);
          const price = parseFloat(p.priceUsd) || 0;
          if (price === 0) continue;
          poolCache.set(mint, {
            dex: p.dexId || "DexScreener",
            baseMint: mint,
            quoteMint: USDC_ADDRESS,
            price,
          });
          if (poolCache.size >= 200) break;
        } catch {
          continue;
        }
      }
      page++;
    } catch (e) {
      console.warn("DexScreener page error:", e.message);
      break;
    }
  }
  console.log(`Loaded ${poolCache.size} pools from fallback`);
}

// ----------------------  BATCH SCAN  ----------------------
let currentIndex = 0;
function getNextTokenBatch() {
  const arr = Array.from(poolCache.values());
  const batch = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const item = arr[(currentIndex + i) % arr.length];
    if (item) batch.push(item);
  }
  currentIndex = (currentIndex + BATCH_SIZE) % arr.length;
  return batch;
}

// ----------------------  ARBITRAGE SCAN  ----------------------
async function scanArbitrage() {
  const batch = getNextTokenBatch();
  const prices = {}; // baseMint -> {dex: price, ...}

  for (const info of batch) {
    const mint = info.baseMint;
    if (!prices[mint]) prices[mint] = {};
    prices[mint][info.dex] = info.price;
  }

  for (const [mint, dexPrices] of Object.entries(prices)) {
    const entries = Object.entries(dexPrices);
    if (entries.length < 2) continue;

    const minDex = entries.reduce((a, b) => (a[1] < b[1] ? a : b));
    const maxDex = entries.reduce((a, b) => (a[1] > b[1] ? a : b));
    const spread = ((maxDex[1] - minDex[1]) / minDex[1]) * 100;

    if (spread > SPREAD_THRESHOLD) {
      const token = allTokens.find((t) => t.address === mint);
      const msg = `🚨 Fat arb: ${token?.symbol || mint}\nBuy ${minDex[0]}: ${minDex[1].toFixed(6)}\nSell ${maxDex[0]}: ${maxDex[1].toFixed(6)}\nSpread: ${spread.toFixed(2)}%`;
      console.log(msg);
      await sendTelegramMessage(msg);
    }
  }
}

// ----------------------  HEALTH CHECK  ----------------------
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Meme-coin on-chain arbitrage bot running\n");
  })
  .listen(PORT, () => console.log(`🌍 Health server on port ${PORT}`));

// ----------------------  START  ----------------------
// ----------------------  SAFE START-UP  ----------------------
try {
  await loadTokens();
  await buildPoolCache();
  setInterval(scanArbitrage, SCAN_INTERVAL);
  console.log("🤖 Meme-coin on-chain arbitrage bot started (Raydium + Orca)...");
  await sendTelegramMessage("✅ Bot deployed: scanning cached pools for ≥2 % gaps!");
} catch (e) {
  console.error("💥 Start-up crash:", e);
  process.exit(1); // fail fast so Render shows the error
}
