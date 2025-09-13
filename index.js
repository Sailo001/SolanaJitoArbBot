// index.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import express from 'express';
import { Keypair, Connection, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

// ----------------- CONFIG (from env) -----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRIVATE_KEY_BASE58 = process.env.PRIVATE_KEY; // base58 secret key
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = Number(process.env.PORT || 10000);
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS || 30000), 10000);
const PROFIT_THRESHOLD_PCT = Number(process.env.PROFIT_THRESHOLD_PCT || 2.0); // percent
const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API || 'https://quote-api.jup.ag/v6/quote';
const RAYDIUM_POOLS_API = process.env.RAYDIUM_POOLS_API || 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
const POOL_FETCH_RETRIES = Number(process.env.POOL_FETCH_RETRIES || 4);
const JUPITER_TIMEOUT_MS = Number(process.env.JUPITER_TIMEOUT_MS || 7000);

// safety checks
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set in environment');
  process.exit(1);
}
if (!PRIVATE_KEY_BASE58) {
  console.error('❌ PRIVATE_KEY must be set (base58). If you only want detection, you can set a dummy key but the code expects a key).');
  // not exiting — detection logic doesn't require sending txs, but wallet is loaded for consistency
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

// load wallet (optional)
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

// ----------------- RAYDIUM POOLS (filtered by watchlist) -----------------
let filteredPools = []; // array of pool objects that involve watchlist tokens
async function refreshFilteredPools() {
  try {
    const allPools = await fetchJsonWithRetry(RAYDIUM_POOLS_API, {}, POOL_FETCH_RETRIES, 3000);
    // allPools is large; filter by mints in watchlist set
    const mintSet = new Set(watchlist.map(t => (t.mint || t.address).toString()));
    // Raydium's JSON is an object keyed by pool id or sometimes array. Normalize:
    const items = Array.isArray(allPools) ? allPools : Object.values(allPools || {});
    filteredPools = items.filter(p => mintSet.has(p.baseMint) || mintSet.has(p.quoteMint));
    console.log(`✅ Raydium pools filtered: ${filteredPools.length} pools relevant to watchlist`);
  } catch (err) {
    console.error('❌ Failed to refresh Raydium pools:', err.message);
    // keep previous filteredPools if any
  }
}

// ----------------- PRICE HELPERS -----------------
// get approximate price from a Raydium pool object using reserves: price = quoteReserve / baseReserve
function poolPrice(pool, forBase = true) {
  try {
    const baseReserve = Number(pool.baseReserve);
    const quoteReserve = Number(pool.quoteReserve);
    if (!baseReserve || !quoteReserve) return null;
    // price in quote per base
    return quoteReserve / baseReserve;
  } catch {
    return null;
  }
}

// Jupiter single-quote helper (returns outAmount integer string)
async function getJupiterOutAmount(inputMint, outputMint, amountUiScaled) {
  // amountUiScaled should be integer amount in smallest units
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUiScaled}&slippage=1`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JUPITER_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Jupiter ${res.status} ${txt.slice(0,200)}`);
    }
    const json = await res.json();
    if (!json || !json.data || !json.data[0]) return null;
    return json.data[0].outAmount; // string integer
  } catch (err) {
    console.warn('⚠️ Jupiter quote failed:', err.message);
    return null;
  }
}

// ----------------- ARBITRAGE DETECTION -----------------
// For each token in watchlist:
//  - gather all filteredPools that include token
//  - compute pool price (quote per base) from reserves
//  - find cheapest pool price (where you can buy base cheapest) and most expensive (sell highest)
//  - compute spread = (sell - buy) / buy * 100
//  - notify if spread >= PROFIT_THRESHOLD_PCT
async function scanArbOnce() {
  try {
    if (!filteredPools.length) {
      console.log('⚠️ No filtered pools available; attempting refresh.');
      await refreshFilteredPools();
      if (!filteredPools.length) {
        console.log('⚠️ Still no filtered pools; skipping this scan cycle');
        return;
      }
    }

    console.log(`🔎 Scanning ${filteredPools.length} pools for ${watchlist.length} tokens`);

    for (const tk of watchlist) {
      const mint = tk.mint || tk.address;
      const decimals = Number(tk.decimals ?? 6);
      const symbol = tk.symbol || mint.slice(0,6);

      // find pools involving this mint
      const related = filteredPools.filter(p => p.baseMint === mint || p.quoteMint === mint);
      if (related.length < 2) continue;

      // For each pool compute price expressed as quote-per-base where base==mint else invert
      const prices = [];
      for (const p of related) {
        let price;
        if (p.baseMint === mint) {
          // pool price is quote/base = price of base in quote
          price = poolPrice(p, true);
        } else if (p.quoteMint === mint) {
          // pool price computed as base/quote => price of quote in base; invert to get quote-per-base
          const inv = poolPrice(p, true);
          // p.baseMint is other token; inv is quoteReserve/baseReserve -> still quote/base but careful: if quoteMint === mint,
          // when quote is "baseReserve"? Raydium reserve naming varies; attempt to handle common structure by checking fields:
          // We will attempt to compute price of mint in terms of the other token by examining roles:
          // If quoteMint === mint then baseReserve/quoteReserve gives base per quote, so invert to quote per base.
          const baseReserve = Number(p.baseReserve);
          const quoteReserve = Number(p.quoteReserve);
          if (!baseReserve || !quoteReserve) continue;
          price = baseReserve / quoteReserve; // price of quote per base
        } else {
          continue;
        }
        if (!price || !isFinite(price)) continue;
        prices.push({ pool: p, price });
      }

      if (prices.length < 2) continue;

      // buy on cheapest price, sell on highest price
      prices.sort((a,b) => a.price - b.price);
      const buy = prices[0];
      const sell = prices[prices.length - 1];

      const spreadPct = ((sell.price - buy.price) / buy.price) * 100;

      if (Math.abs(spreadPct) >= PROFIT_THRESHOLD_PCT) {
        // Compose a useful alert: include pool ids and approximate prices, and attempt to compute Jupiter cross-check
        const buyPrice = buy.price;
        const sellPrice = sell.price;

        // Quick Jupiter cross-check: simulate swapping 1 base -> quote -> base using Jupiter (use smallest unit = 10^decimals)
        const unitAmount = Math.pow(10, decimals);
        const out1 = await getJupiterOutAmount(mint, buy.pool?.quoteMint || buy.pool?.other, unitAmount);
        // we won't rely on Jupiter cross-check for alert if it fails. Keep alert even if jupiter check fails.
        const msg =
`💰 *Arbitrage Opportunity Detected*
Token: *${symbol}* (\`${mint}\`)
Buy pool: \`${buy.pool?.id || buy.pool?.lpMint || buy.pool?.poolId || buy.pool?.marketId || 'unknown'}\` — price ${buyPrice.toFixed(8)}
Sell pool: \`${sell.pool?.id || sell.pool?.lpMint || sell.pool?.poolId || sell.pool?.marketId || 'unknown'}\` — price ${sellPrice.toFixed(8)}
Spread: *${spreadPct.toFixed(2)}%*

_Only a detector — does not execute trades._`;

        console.log(msg.replace(/\*/g, '')); // console without Markdown
        await telegramSend(msg);
      }
    }
  } catch (err) {
    console.error('❌ scanArbOnce failed:', err.message);
  }
}

// ----------------- INITIALIZATION + loop -----------------
async function startup() {
  // initial fetch
  await refreshFilteredPools();
  // schedule pool refresh less frequently than scans
  setInterval(refreshFilteredPools, 15 * 60 * 1000); // every 15m
  // schedule scanner
  setInterval(scanArbOnce, SCAN_INTERVAL_MS);

  // run first scan immediately after a short delay
  setTimeout(scanArbOnce, 3000);
}

// ----------------- EXPRESS health & minimal webhook -----------------
app.get('/', (req, res) => res.send('✅ Solana arbitrage detector (docker) running'));
app.post(`/webhook/${TELEGRAM_TOKEN}`, (req, res) => {
  // optional: we don't parse body here; Telegraf can handle if used.
  res.sendStatus(200);
});

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
  startup().catch(err => console.error('startup failed', err));
});
