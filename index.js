// index.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createServer } from 'http';

// === CONFIG ===
const RPC_URL = process.env.MEV_RELAY || 'https://api.mainnet-beta.solana.com';
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS) || 30000, 30000);
const PORT = process.env.PORT || 10000;

const RAYDIUM_POOLS = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

// === TELEGRAM ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
    });
  } catch (err) {
    console.error('❌ Telegram error:', err.message);
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
let raydiumBackoff = 0;

// === REFRESH TOKENS (from local tokens.json) ===
async function refreshTokens() {
  try {
    const data = fs.readFileSync('./tokens.json', 'utf8');
    tokenCache = JSON.parse(data);
    console.log(`✅ Loaded ${tokenCache.length} tokens from tokens.json`);
  } catch (err) {
    console.error('❌ Failed to load tokens.json:', err.message);
  }
}

// === REFRESH POOLS (with retry + backoff) ===
async function refreshPools(retries = 5) {
  if (raydiumBackoff > Date.now()) {
    console.log('⏳ Raydium pool refresh skipped (backoff active)');
    return;
  }
  try {
    console.log('📡 Fetching Raydium pools (filtered)...');
    const res = await fetch(RAYDIUM_POOLS);
    if (res.status === 429) {
      console.error('⚠️ Raydium rate-limited; backoff 15m');
      raydiumBackoff = Date.now() + 15 * 60 * 1000;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pools = await res.json();

    // Filter pools to only those with tokens in tokens.json
    const watched = new Set(tokenCache.map(t => t.address));
    poolCache = pools.filter(p => watched.has(p.baseMint) || watched.has(p.quoteMint));

    console.log(`✅ Loaded ${poolCache.length} relevant Raydium pools`);
  } catch (err) {
    console.error('❌ Pool refresh failed:', err.message);
    if (retries > 0) {
      console.log(`🔁 Retrying pool fetch in 10s... (retries left: ${retries})`);
      setTimeout(() => refreshPools(retries - 1), 10000);
    }
  }
}

// === PRICE CALCULATOR ===
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

// === SCAN LOOP ===
async function scanArbitrage() {
  if (!tokenCache.length || !poolCache.length) {
    console.log('⚠️ Token or pool cache empty, skipping scan');
    return;
  }

  console.log(`🔎 Scanning ${poolCache.length} pools for opportunities...`);

  for (let i = 0; i < poolCache.length; i++) {
    const pool = poolCache[i];
    const price = getPoolPrice(pool);
    if (!price) continue;

    // Compare with another pool of same base token
    const alt = poolCache.find(
      p => p.baseMint === pool.baseMint && p.id !== pool.id
    );
    if (!alt) continue;

    const altPrice = getPoolPrice(alt);
    if (!altPrice) continue;

    const spread = ((altPrice - price) / price) * 100;
    if (Math.abs(spread) > 5) {
      const msg = `💰 Arbitrage found!\nToken: ${pool.baseMint}\nPool1: ${price.toFixed(6)}\nPool2: ${altPrice.toFixed(6)}\nSpread: ${spread.toFixed(2)}%`;
      console.log(msg);
      await sendTelegram(msg);
    }
  }
}

// === STARTUP ===
(async () => {
  console.log('🚀 Starting Solana Arbitrage Bot...');
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
