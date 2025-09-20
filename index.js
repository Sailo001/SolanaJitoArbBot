// index.js
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import AbortController from 'abort-controller';
import http from "http";
import dotenv from "dotenv";
dotenv.config();

// Force stdout flush for Docker logs
process.stdout.write = (function(write) {
  return function(string, encoding, fd) {
    write.apply(process.stdout, arguments);
    process.stdout.flush?.();
  };
})(process.stdout.write);

// Config
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const CHAT_ID = process.env.CHAT_ID?.trim();
const RPC_URL = (process.env.RPC_URL || "https://api.mainnet-beta.solana.com").trim(); // More reliable
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "0.5");
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "30000");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "20");
const QUOTE_TOKEN = process.env.QUOTE_TOKEN || "USDC";
const MAX_DEXSCREENER_PAGES = parseInt(process.env.MAX_DEXSCREENER_PAGES || "5");

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing");
  process.exit(1);
}

const connection = new Connection(RPC_URL, "confirmed");
const USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------------------- TELEGRAM ----------------------
async function sendTelegramMessage(msg) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg }),
    });
    const result = await response.json();
    if (!result.ok) {
      console.error("❌ Telegram error:", result.description);
    } else {
      console.log("✅ Telegram sent successfully");
    }
  } catch (err) {
    console.error("⚠️ Telegram send error:", err.message);
  }
}

// ---------------------- FETCH WITH TIMEOUT ----------------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Solana-Arb-Bot/1.0',
        ...(options.headers || {}),
      },
    });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Timeout: ${url}`);
    }
    throw err;
  }
}

// ---------------------- TOKEN LIST ----------------------
let allTokens = [];
async function loadTokens() {
  try {
    const res = await fetchWithTimeout(
      "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json".trim()
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
    console.error("⚠️ Token list fetch error:", err.message);
  }
}

// ---------------------- POOL CACHE ----------------------
const poolCache = new Map();

async function buildPoolCache() {
  console.log("🏗️ Building pool cache...");

  // Raydium v3
  try {
    console.log("📡 Fetching Raydium v3 pools...");
    const res = await fetchWithTimeout("https://api.raydium.io/v2/main/ammV3Pools", {}, 20000);
    if (res.ok) {
      const data = await res.json();
      const pools = data?.data || [];
      for (const pool of pools) {
        const [mintA, mintB] = [pool.mintA?.address, pool.mintB?.address];
        const usdPrice = parseFloat(pool.lpPrice?.usd) || 0;
        if (usdPrice === 0) continue;

        let baseMint;
        if (mintA === USDC_ADDRESS) baseMint = mintB;
        else if (mintB === USDC_ADDRESS) baseMint = mintA;
        else continue;

        if (!baseMint) continue;
        try {
          new PublicKey(baseMint);
          poolCache.set(baseMint, {
            dex: "Raydium v3",
            baseMint,
            quoteMint: USDC_ADDRESS,
            price: usdPrice,
          });
        } catch { continue; }
      }
      console.log(`✅ Cached ${poolCache.size} Raydium v3 pools`);
      if (poolCache.size > 200) return;
    }
  } catch (e) {
    console.warn("⚠️ Raydium v3 failed:", e.message);
  }

  // DexScreener multi-page
  console.log("🔄 Fetching DexScreener pools...");
  let page = 1;
  while (poolCache.size < 500 && page <= MAX_DEXSCREENER_PAGES) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=solana&page=${page}`;
      console.log(`📄 Page ${page}...`);
      const res = await fetchWithTimeout(url, {}, 15000);
      if (!res.ok) break;
      const data = await res.json();
      const pairs = data?.pairs || [];
      if (!pairs.length) break;

      for (const p of pairs) {
        const mint = p.baseToken?.address;
        const price = parseFloat(p.priceUsd) || 0;
        if (!mint || price === 0) continue;
        try {
          new PublicKey(mint);
          poolCache.set(mint, {
            dex: p.dexId || "DexScreener",
            baseMint: mint,
            quoteMint: USDC_ADDRESS,
            price,
          });
        } catch { continue; }
      }
      console.log(`✅ Page ${page}: total pools = ${poolCache.size}`);
      page++;
      await new Promise(r => setTimeout(r, 1000)); // Rate limit
    } catch (e) {
      console.warn(`⚠️ DexScreener page ${page}:`, e.message);
      break;
    }
  }

  console.log(`📊 Final pool cache: ${poolCache.size} pools`);
  if (poolCache.size === 0) {
    await sendTelegramMessage("❌ CRITICAL: No pools loaded. Check APIs.");
  }
}

// ---------------------- BATCH SCAN ----------------------
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

// ---------------------- ARBITRAGE SCAN ----------------------
async function scanArbitrage() {
  if (poolCache.size === 0) {
    console.log("⏳ Waiting for pool cache...");
    return;
  }

  const batch = getNextTokenBatch();
  const prices = {};

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
      const msg = `🚨 ARB: ${token?.symbol || mint}\nBuy ${minDex[0]}: $${minDex[1].toFixed(6)}\nSell ${maxDex[0]}: $${maxDex[1].toFixed(6)}\nSpread: ${spread.toFixed(2)}%`;
      console.log(msg);
      await sendTelegramMessage(msg);
    }
  }
}

// ---------------------- HEALTH SERVER — START IMMEDIATELY ----------------------
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  const status = poolCache.size > 0 ? "✅ Healthy" : "🟡 Starting...";
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Solana Arb Bot\nStatus: ${status}\nPools: ${poolCache.size}\n`);
}).listen(PORT, () => {
  console.log(`🌍 Health server on port ${PORT}`);
});

// ---------------------- START BOT ----------------------
(async () => {
  try {
    console.log("🚀 Bot starting...");

    // Load tokens (fast)
    await loadTokens();

    // Defer heavy work
    setTimeout(async () => {
      try {
        await buildPoolCache();
        await sendTelegramMessage(`✅ Bot LIVE! Monitoring ${poolCache.size} tokens for ≥${SPREAD_THRESHOLD}% arb.`);
        console.log("🤖 Bot fully initialized!");
      } catch (err) {
        console.error("💥 Pool cache error:", err.message);
        await sendTelegramMessage(`💥 Pool cache failed: ${err.message}`);
      }
    }, 2000);

    // Start scanning
    setInterval(scanArbitrage, SCAN_INTERVAL);

  } catch (err) {
    console.error("💥 Fatal error:", err.message);
    await sendTelegramMessage(`💥 Bot crashed: ${err.message}`);
    process.exit(1);
  }
})();

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});
