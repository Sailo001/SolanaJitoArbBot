// index.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import express from 'express';
import { Keypair, Connection } from '@solana/web3.js';
import bs58 from 'bs58';

// ----------------- CONFIG -----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRIVATE_KEY_BASE58 = process.env.PRIVATE_KEY; 
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = Number(process.env.PORT || 10000);
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS || 30000), 10000);
const PROFIT_THRESHOLD_PCT = Number(process.env.PROFIT_THRESHOLD_PCT || 2.0);
const JUPITER_TOKENS_API = 'https://quote-api.jup.ag/v7/tokens';
const JUPITER_QUOTE_API  = 'https://quote-api.jup.ag/v7/quote';
const RAYDIUM_POOLS_API = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
const POOL_FETCH_RETRIES = Number(process.env.POOL_FETCH_RETRIES || 4);
const JUPITER_TIMEOUT_MS = Number(process.env.JUPITER_TIMEOUT_MS || 7000);

// ----------------- SAFETY CHECKS -----------------
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set in environment');
  process.exit(1);
}

// ----------------- SETUP -----------------
const app = express();
app.use(express.json());

let watchlist = [];
try {
  const raw = fs.readFileSync('./tokens.json', 'utf8');
  watchlist = JSON.parse(raw);
  if (!Array.isArray(watchlist) || watchlist.length === 0) {
    throw new Error('tokens.json must be an array of { symbol, mint, decimals }');
  }
  console.log(`✅ tokens.json loaded: ${watchlist.length} tokens`);
} catch (err) {
  console.error('❌ failed to load tokens.json:', err.message);
  process.exit(1);
}

// Load wallet
let wallet = null;
try {
  if (PRIVATE_KEY_BASE58) {
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
    console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
  }
} catch (err) {
  console.warn('⚠️ Failed to load PRIVATE_KEY (base58). Continuing in detection-only mode.');
  wallet = null;
}

const connection = new Connection(RPC_URL, 'confirmed');
console.log(`🌐 RPC: ${RPC_URL}`);

// ----------------- TELEGRAM -----------------
async function telegramSend(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const t = await res.text().catch(() => '<no body>');
      console.error('❌ Telegram send error', res.status, t);
    }
  } catch (err) {
    console.error('❌ Telegram send failed', err.message);
  }
}

// ----------------- UTIL: fetch with retry -----------------
async function fetchJsonWithRetry(url, opts = {}, retries = 3, backoffMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeout || 10000);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${txt.slice(0,200)}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        console.warn(`⚠️ fetch failed (attempt ${attempt}/${retries}) ${url} -> ${err.message}. retrying in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs *= 2;
        continue;
      }
      throw err;
    }
  }
}

// ----------------- RAYDIUM POOLS -----------------
let filteredPools = [];
async function refreshFilteredPools() {
  try {
    const allPools = await fetchJsonWithRetry(RAYDIUM_POOLS_API, {}, POOL_FETCH_RETRIES, 3000);
    const mintSet = new Set(watchlist.map(t => (t.mint || t.address).toString()));
    const items = Array.isArray(allPools) ? allPools : Object.values(allPools || {});
    filteredPools = items.filter(p => mintSet.has(p.baseMint) || mintSet.has(p.quoteMint));
    console.log(`✅ Raydium pools filtered: ${filteredPools.length} pools relevant to watchlist`);
  } catch (err) {
    console.error('❌ Failed to refresh Raydium pools:', err.message);
  }
}

// ----------------- PRICE HELPERS -----------------
function poolPrice(pool, forBase = true) {
  try {
    const baseReserve = Number(pool.baseReserve);
    const quoteReserve = Number(pool.quoteReserve);
    if (!baseReserve || !quoteReserve) return null;
    return quoteReserve / baseReserve;
  } catch {
    return null;
  }
}

async function getJupiterOutAmount(inputMint, outputMint, amountUiScaled) {
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUiScaled}&slippage=1`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JUPITER_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.data || !json.data[0]) return null;
    return json.data[0].outAmount;
  } catch {
    return null;
  }
}

// ----------------- ARBITRAGE DETECTION -----------------
async function scanArbOnce() {
  try {
    if (!filteredPools.length) {
      console.log('⚠️ No filtered pools; attempting refresh.');
      await refreshFilteredPools();
      if (!filteredPools.length) return;
    }

    console.log(`🔎 Scanning ${filteredPools.length} pools for ${watchlist.length} tokens`);

    for (const tk of watchlist) {
      const mint = tk.mint || tk.address;
      const decimals = Number(tk.decimals ?? 6);
      const symbol = tk.symbol || mint.slice(0,6);

      const related = filteredPools.filter(p => p.baseMint === mint || p.quoteMint === mint);
      if (related.length < 2) continue;

      const prices = [];
      for (const p of related) {
        let price = (p.baseMint === mint) ? poolPrice(p, true) : poolPrice(p, true) ? Number(p.baseReserve)/Number(p.quoteReserve) : null;
        if (!price || !isFinite(price)) continue;
        prices.push({ pool: p, price });
      }

      if (prices.length < 2) continue;

      prices.sort((a,b) => a.price - b.price);
      const buy = prices[0];
      const sell = prices[prices.length - 1];
      const spreadPct = ((sell.price - buy.price)/buy.price)*100;

      if (Math.abs(spreadPct) >= PROFIT_THRESHOLD_PCT) {
        const msg = 
`💰 *Arbitrage Opportunity Detected*
Token: *${symbol}* (\`${mint}\`)
Buy pool: \`${buy.pool?.id || buy.pool?.lpMint || 'unknown'}\` — price ${buy.price.toFixed(8)}
Sell pool: \`${sell.pool?.id || sell.pool?.lpMint || 'unknown'}\` — price ${sell.price.toFixed(8)}
Spread: *${spreadPct.toFixed(2)}%*

_Only a detector — does not execute trades._`;

        console.log(msg.replace(/\*/g, ''));
        await telegramSend(msg);
      }
    }
  } catch (err) {
    console.error('❌ scanArbOnce failed:', err.message);
  }
}

// ----------------- INITIALIZATION -----------------
async function startup() {
  await refreshFilteredPools();
  setInterval(refreshFilteredPools, 15*60*1000);
  setInterval(scanArbOnce, SCAN_INTERVAL_MS);
  setTimeout(scanArbOnce, 3000);
}

// ----------------- EXPRESS -----------------
app.get('/', (req,res) => res.send('✅ Solana arbitrage detector running'));
app.post(`/webhook/${TELEGRAM_TOKEN}`, (req,res) => res.sendStatus(200));

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
  startup().catch(err => console.error('startup failed', err));
});
