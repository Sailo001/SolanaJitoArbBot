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
const poolCache = new Map(); // poolPubkey -> {dex, baseMint, price, reserveBase, reserveQuote}

async function buildPoolCache() {
  for (const [dexName, programId] of Object.entries(dexPrograms)) {
    try {
      const progKey = new PublicKey(programId);
      const accounts = await connection.getProgramAccounts(progKey, {
        commitment: "confirmed",
        dataSlice: { offset: 0, length: 0 }, // header only
      });
      console.log(`✅ ${accounts.length} raw accounts from ${dexName}`);

      for (const acc of accounts) {
        const info = await connection.getAccountInfo(acc.pubkey);
        if (!info) continue;
        const data = info.data;
        try {
          // Raydium AMM v4 reserves at offsets 64/72 (8 bytes each)
          const reserveBase = new BN(data.slice(64, 72), "le").toNumber();
          const reserveQuote = new BN(data.slice(72, 80), "le").toNumber();
          if (reserveBase === 0 || reserveQuote === 0) continue;

          const baseMint = new PublicKey(data.slice(0, 32)).toString();
          const quoteMint = new PublicKey(data.slice(32, 64)).toString();
          if (quoteMint !== USDC_ADDRESS) continue;

          const price = reserveQuote / reserveBase;
          poolCache.set(acc.pubkey.toString(), {
            dex: dexName,
            baseMint,
            quoteMint,
            reserveBase,
            reserveQuote,
            price,
          });
        } catch {
          continue;
        }
      }
      await sleep(200); // polite gap
    } catch (err) {
      console.warn(`⚠️ ${dexName} cache build error:`, err.message);
    }
  }
  console.log(`🧩 Total cached USDC-paired pools: ${poolCache.size}`);
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
await loadTokens();
await buildPoolCache();
setInterval(scanArbitrage, SCAN_INTERVAL);
console.log("🤖 Meme-coin on-chain arbitrage bot started (Raydium + Orca)...");
await sendTelegramMessage("✅ Bot deployed: scanning cached pools for ≥2 % gaps!");
