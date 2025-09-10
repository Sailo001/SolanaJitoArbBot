// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createServer } from 'http';
import { Telegraf } from 'telegraf';

// === CONFIG ===
const RPC_URL = process.env.MEV_RELAY || 'https://api.mainnet-beta.solana.com';
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS) || 30000, 30000);
const PORT = process.env.PORT || 10000;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const JUPITER_ENDPOINTS = [
  'https://token.jup.ag/all',
  'https://quote-api.jup.ag/v6/tokens'
];
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

// === TELEGRAM BOT ===
const bot = new Telegraf(TG_BOT_TOKEN);
async function sendAlert(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('⚠️ Telegram not configured, skipping alert');
    return;
  }
  try {
    await bot.telegram.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('❌ Failed to send Telegram alert:', err.message);
  }
}

// === CACHES ===
let tokenCache = [];
let poolCache = [];
let raydiumBackoff = 0;

// === REFRESH FUNCTIONS ===
async function refreshTokens() {
  for (const url of JUPITER_ENDPOINTS) {
    try {
      console.log(`Fetching Jupiter token list from: ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tokenCache = await res.json();
      console.log(`✅ Loaded ${tokenCache.length} tokens`);
      return;
    } catch (err) {
      console.error(`❌ Token refresh failed from ${url}:`, err.message);
    }
  }
  console.error('❌ All Jupiter token endpoints failed');
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
    console.log('⚠️ Token or pool cache empty, skipping scan');
    return;
  }

  console.log(`🔎 Scanning ${poolCache.length} pools for opportunities...`);

  for (let i = 0; i < poolCache.length; i++) {
    const pool = poolCache[i];
    const price = getPoolPrice(pool);
    if (!price) continue;

    // Compare with random other pool of same base token
    const alt = poolCache.find(
      p => p.baseMint === pool.baseMint && p.id !== pool.id
    );
    if (!alt) continue;

    const altPrice = getPoolPrice(alt);
    if (!altPrice) continue;

    const spread = ((altPrice - price) / price) * 100;
    if (Math.abs(spread) > 5) {
      const msg =
        `💰 *Arbitrage Found!*\n\n` +
        `Token: \`${pool.baseMint}\`\n` +
        `Pool1 Price: ${price.toFixed(6)}\n` +
        `Pool2 Price: ${altPrice.toFixed(6)}\n` +
        `Spread: *${spread.toFixed(2)}%*`;
      console.log(msg);
      await sendAlert(msg);
    }
  }
}

// === PLACEHOLDER TRADE ===
async function executeTrade(poolA, poolB, spread) {
  try {
    console.log(`🚀 Executing trade between ${poolA.id} and ${poolB.id}`);
    // In real impl: build swap tx, sign with wallet, send via connection.sendTransaction()
    const tx = new Transaction();
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize());
    console.log(`✅ Trade sent: https://solscan.io/tx/${sig}`);
  } catch (err) {
    console.error('❌ Trade execution failed:', err.message);
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
