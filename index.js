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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const JUPITER_TOKENS = 'https://token.jup.ag/all';
const RAYDIUM_POOLS = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

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

// === REFRESH FUNCTIONS ===
async function refreshTokens() {
  try {
    console.log(`Fetching Jupiter token list from: ${JUPITER_TOKENS}`);
    const res = await fetch(JUPITER_TOKENS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tokenCache = await res.json();
    console.log(`✅ Loaded ${tokenCache.length} tokens from Jupiter`);
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

// === TELEGRAM ALERT ===
async function sendTelegramMessage(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('❌ Failed to send Telegram message:', err.message);
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

    const alt = poolCache.find(p => p.baseMint === pool.baseMint && p.id !== pool.id);
    if (!alt) continue;

    const altPrice = getPoolPrice(alt);
    if (!altPrice) continue;

    const spread = ((altPrice - price) / price) * 100;
    if (Math.abs(spread) > 5) {
      const token = pool.baseMint;
      console.log(`💰 Arbitrage found! Token ${token}`);
      console.log(`Pool1: ${price.toFixed(6)}, Pool2: ${altPrice.toFixed(6)}, Spread: ${spread.toFixed(2)}%`);

      const message = `
💰 *Arbitrage Opportunity!*

🟢 *Buy*: ${price.toFixed(6)}
🔴 *Sell*: ${altPrice.toFixed(6)}

📌 Token: \`${token}\`
📊 Spread: *${spread.toFixed(2)}%*
      `;

      await sendTelegramMessage(message);
    }
  }
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
