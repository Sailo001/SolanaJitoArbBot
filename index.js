// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createServer } from 'http';

// === CONFIG ===
const RPC_URL = process.env.MEV_RELAY || 'https://api.mainnet-beta.solana.com';
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS) || 30000, 30000);
const PORT = process.env.PORT || 10000;

const JUPITER_TOKENS = 'https://token.jup.ag/all';
const RAYDIUM_POOLS = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

// === TELEGRAM ===
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log(`📭 Telegram not configured: ${msg}`);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg }),
    });
    console.log(`📩 Sent Telegram alert: ${msg}`);
  } catch (err) {
    console.error('❌ Failed to send Telegram alert:', err.message);
  }
}

// === WALLET ===
let wallet;
try {
  const secret = process.env.PRIVATE_KEY;
  if (!secret) throw new Error('Missing PRIVATE_KEY in .env');
  wallet = Keypair.fromSecretKey(bs58.decode(secret));
  console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
} catch (e) {
  console.error('❌ Failed to load wallet:', e.message);
  process.exit(1);
}

// === CONNECTION ===
const connection = new Connection(RPC_URL, 'confirmed');
console.log(`✅ Using MEV_RELAY: ${RPC_URL}`);

// === CACHES ===
let tokenCache = [];
let poolCache = [];
let tokenBatches = [];
let currentBatch = 0;
let raydiumBackoff = 0;

// === REFRESH FUNCTIONS ===
async function refreshTokens() {
  try {
    console.log(`Fetching Jupiter token list from: ${JUPITER_TOKENS}`);
    const res = await fetch(JUPITER_TOKENS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tokenCache = await res.json();

    // Split into batches of 500 tokens each
    const BATCH_SIZE = 500;
    tokenBatches = [];
    for (let i = 0; i < tokenCache.length; i += BATCH_SIZE) {
      tokenBatches.push(tokenCache.slice(i, i + BATCH_SIZE));
    }

    console.log(`✅ Loaded ${tokenCache.length} tokens, split into ${tokenBatches.length} batches`);
  } catch (err) {
    console.error('❌ Token refresh failed:', err.message);
  }
}

async function refreshPools() {
  if (raydiumBackoff > Date.now()) {
    console.log('Raydium pool refresh skipped (backoff active)');
    return;
  }
  try {
    console.log(`Fetching Raydium pools from ${RAYDIUM_POOLS}`);
    const res = await fetch(RAYDIUM_POOLS);
    if (res.status === 429) {
      console.error('Raydium rate-limited; backoff 15m');
      raydiumBackoff = Date.now() + 15 * 60 * 1000;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    poolCache = await res.json();
    console.log(`✅ Loaded ${poolCache.length} Raydium pools`);
  } catch (err) {
    console.error('❌ Pool refresh failed:', err.message);
  }
}

// === MOCK PRICE CALCULATOR ===
function getPoolPrice(pool) {
  try {
    const baseReserve = Number(pool.baseReserve);
    const quoteReserve = Number(pool.quoteReserve);
    if (!baseReserve || !quoteReserve) return null;
    return quoteReserve / baseReserve;
  } catch {
    return null;
  }
}

// === SCAN LOOP (BATCHED) ===
async function scanArbitrage() {
  if (!tokenBatches.length || !poolCache.length) {
    console.log('⚠️ Token batches or pool cache empty, skipping scan');
    return;
  }

  const batch = tokenBatches[currentBatch];
  console.log(`🔎 Scanning batch ${currentBatch + 1}/${tokenBatches.length} with ${batch.length} tokens`);

  // Pick pools only for tokens in this batch
  const batchPools = poolCache.filter(p =>
    batch.some(t => t.address === p.baseMint || t.address === p.quoteMint)
  );

  for (let i = 0; i < batchPools.length; i++) {
    const pool = batchPools[i];
    const price = getPoolPrice(pool);
    if (!price) continue;

    const alt = batchPools.find(
      p => p.baseMint === pool.baseMint && p.id !== pool.id
    );
    if (!alt) continue;

    const altPrice = getPoolPrice(alt);
    if (!altPrice) continue;

    const spread = ((altPrice - price) / price) * 100;
    if (Math.abs(spread) > 5) {
      const msg =
        `💰 Arbitrage found!\n\n` +
        `Token: ${pool.baseMint}\n` +
        `Pool1: ${price.toFixed(6)}\n` +
        `Pool2: ${altPrice.toFixed(6)}\n` +
        `Spread: ${spread.toFixed(2)}%\n`;

      console.log(msg);
      await sendTelegram(msg);
    }
  }

  // Rotate to next batch
  currentBatch = (currentBatch + 1) % tokenBatches.length;
}

// === STARTUP ===
(async () => {
  await refreshTokens();
  await refreshPools();

  setInterval(refreshTokens, 10 * 60 * 1000); // every 10m
  setInterval(refreshPools, 15 * 60 * 1000);  // every 15m
  setInterval(scanArbitrage, SCAN_INTERVAL_MS);

  console.log(`🔁 Auto-scan enabled. Interval ${SCAN_INTERVAL_MS}ms`);

  // Healthcheck server
  createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
  }).listen(PORT, () => console.log(`🌐 Health server listening on ${PORT}`));
})();
