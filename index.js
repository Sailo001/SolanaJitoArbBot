// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createServer } from 'http';

// === CONFIG ===
const RPC_URL = process.env.MEV_RELAY || 'https://api.mainnet-beta.solana.com';
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS) || 30000, 30000);
const PORT = process.env.PORT || 3000;

const JUPITER_TOKENS = 'https://token.jup.ag/all';
const RAYDIUM_POOLS = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
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

// === TELEGRAM ALERT ===
async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('❌ Telegram send failed:', err.message);
  }
}

// === RETRY FETCH ===
async function fetchWithRetry(url, retries = 5, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      console.log(`📡 Fetching ${url} (attempt ${i}/${retries})...`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`⚠️ Fetch failed: ${err.message}`);
      if (i < retries) {
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// === REFRESH FUNCTIONS ===
async function refreshTokens() {
  try {
    const allTokens = await fetchWithRetry(JUPITER_TOKENS);
    // Keep only 100 tokens (avoid memory crash)
    tokenCache = allTokens.slice(0, 100);
    console.log(`✅ Loaded ${tokenCache.length} tokens (filtered from ${allTokens.length})`);
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
    console.log(`📡 Fetching Raydium pools (filtered)...`);
    const allPools = await fetchWithRetry(RAYDIUM_POOLS);
    // Keep only pools for tracked tokens
    poolCache = allPools.filter(p =>
      tokenCache.some(t => t.address === p.baseMint || t.address === p.quoteMint)
    );
    console.log(`✅ Loaded ${poolCache.length} Raydium pools (filtered)`);
  } catch (err) {
    if (err.message.includes('429')) {
      console.error('Raydium rate-limited; backoff 15m');
      raydiumBackoff = Date.now() + 15 * 60 * 1000;
    } else {
      console.error('❌ Pool refresh failed:', err.message);
    }
  }
}

// === PRICE HELPER ===
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
    console.log('⚠️ Skipping arbitrage scan (no data cached yet)');
    return;
  }

  console.log(`🔎 Scanning ${poolCache.length} pools for opportunities...`);

  for (let pool of poolCache) {
    const price = getPoolPrice(pool);
    if (!price) continue;

    // Compare with another pool for same base token
    const alt = poolCache.find(p => p.baseMint === pool.baseMint && p.id !== pool.id);
    if (!alt) continue;

    const altPrice = getPoolPrice(alt);
    if (!altPrice) continue;

    const spread = ((altPrice - price) / price) * 100;
    if (Math.abs(spread) > 5) {
      const msg = `💰 *Arbitrage Opportunity*  
Token: \`${pool.baseMint}\`  
Pool1: ${price.toFixed(6)}  
Pool2: ${altPrice.toFixed(6)}  
Spread: ${spread.toFixed(2)}%`;

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

  // === HEALTH CHECK SERVER FOR RENDER ===
  createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('✅ Solana Arbitrage Bot running!\n');
  }).listen(PORT, () => console.log(`🌐 Health server listening on ${PORT}`));
})();
