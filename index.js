// index.js — production-ready arbitrage detector (watchlist-driven)
import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import { Connection, Keypair } from '@solana/web3.js';

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = Number(process.env.PORT || 10000);
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS || 30000), 10000);
const PROFIT_THRESHOLD_PCT = Number(process.env.PROFIT_THRESHOLD_PCT || 2.0);
const RAYDIUM_POOLS_API = process.env.RAYDIUM_POOLS_API || 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API || 'https://quote-api.jup.ag/v6/quote';
const JUPITER_TIMEOUT_MS = Number(process.env.JUPITER_TIMEOUT_MS || 7000);
const POOL_FETCH_RETRIES = Number(process.env.POOL_FETCH_RETRIES || 3);
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 5 * 60 * 1000);

// basic checks
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are required in environment');
  process.exit(1);
}

// ---------- APP SETUP ----------
const app = express();
app.use(express.json());

// load watchlist
let watchlist = [];
try {
  const raw = fs.readFileSync('./tokens.json', 'utf8');
  watchlist = JSON.parse(raw);
  if (!Array.isArray(watchlist) || watchlist.length === 0) throw new Error('tokens.json must be a non-empty array');
  console.log(`✅ tokens.json loaded: ${watchlist.length} tokens`);
} catch (err) {
  console.error('❌ Failed to load tokens.json:', err.message);
  process.exit(1);
}

// wallet (optional)
let wallet = null;
if (PRIVATE_KEY) {
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
  } catch (err) {
    console.warn('⚠️ Failed to load PRIVATE_KEY (base58). Running detection-only.');
    wallet = null;
  }
} else {
  console.warn('⚠️ PRIVATE_KEY not provided — running detection-only (no txs).');
}

const connection = new Connection(RPC_URL, 'confirmed');
console.log(`🌐 RPC: ${RPC_URL}`);

// ---------- TELEGRAM ----------
async function telegramSend(text, chatId = TELEGRAM_CHAT_ID) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const t = await res.text().catch(() => '<no body>');
      console.error('❌ Telegram send failed', res.status, t);
    }
  } catch (err) {
    console.error('❌ Telegram send error:', err.message);
  }
}

// ---------- HTTP helper with retry ----------
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
        console.warn(`⚠️ fetch failed ${attempt}/${retries} ${url} -> ${err.message}. retry ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs *= 2;
        continue;
      }
      throw err;
    }
  }
}

// ---------- Filter Raydium pools to watchlist ----------
let filteredPools = [];
async function refreshFilteredPools() {
  try {
    const allPools = await fetchJsonWithRetry(RAYDIUM_POOLS_API, {}, POOL_FETCH_RETRIES, 2000);
    const items = Array.isArray(allPools) ? allPools : Object.values(allPools || {});
    const mintSet = new Set(watchlist.map(t => (t.mint || t.address || t.token).toString()));
    filteredPools = items.filter(p => mintSet.has(p.baseMint) || mintSet.has(p.quoteMint));
    console.log(`✅ Raydium pools filtered: ${filteredPools.length} pools relevant to watchlist`);
  } catch (err) {
    console.error('❌ Failed to refresh Raydium pools:', err.message);
  }
}

// ---------- Price helpers ----------
function poolPriceQuotePerBase(pool, targetMint) {
  try {
    const baseReserve = Number(pool.baseReserve);
    const quoteReserve = Number(pool.quoteReserve);
    if (!baseReserve || !quoteReserve) return null;
    if (pool.baseMint === targetMint) return quoteReserve / baseReserve;
    if (pool.quoteMint === targetMint) return baseReserve / quoteReserve;
    return null;
  } catch {
    return null;
  }
}

async function getJupiterOutAmount(inputMint, outputMint, inputAmountSmallest) {
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inputAmountSmallest}&slippage=1`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JUPITER_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${txt.slice(0,200)}`);
    }
    const json = await res.json();
    if (!json || !json.data || !json.data[0]) return null;
    return json.data[0].outAmount;
  } catch (err) {
    console.warn('⚠️ Jupiter quote failed:', err.message);
    return null;
  }
}

// ---------- Alert cooldown ----------
const lastAlertAt = new Map();
function shouldAlert(tokenMint) {
  const last = lastAlertAt.get(tokenMint) || 0;
  const now = Date.now();
  if (now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(tokenMint, now);
  return true;
}

// ---------- Main scan ----------
async function scanArbOnce() {
  try {
    if (!filteredPools.length) {
      console.log('⚠️ filteredPools empty — refreshing');
      await refreshFilteredPools();
      if (!filteredPools.length) { console.log('⚠️ still no pools; skipping'); return; }
    }

    console.log(`🔎 Scanning ${filteredPools.length} pools for ${watchlist.length} tokens`);

    for (const tk of watchlist) {
      const mint = tk.mint || tk.address || tk.token;
      const decimals = Number(tk.decimals ?? 6);
      const symbol = tk.symbol || mint.slice(0,6);

      const related = filteredPools.filter(p => p.baseMint === mint || p.quoteMint === mint);
      if (related.length < 2) continue;

      const priceList = [];
      for (const p of related) {
        const price = poolPriceQuotePerBase(p, mint);
        if (!price || !isFinite(price)) continue;
        priceList.push({ pool: p, price });
      }
      if (priceList.length < 2) continue;

      priceList.sort((a,b) => a.price - b.price);
      const buy = priceList[0];
      const sell = priceList[priceList.length - 1];
      const spreadPct = ((sell.price - buy.price) / buy.price) * 100;

      if (Math.abs(spreadPct) >= PROFIT_THRESHOLD_PCT) {
        if (!shouldAlert(mint)) { console.log(`ℹ️ Skipping ${symbol} due to cooldown`); continue; }

        const buyId = buy.pool?.id || buy.pool?.poolId || buy.pool?.lpMint || 'unknown';
        const sellId = sell.pool?.id || sell.pool?.poolId || sell.pool?.lpMint || 'unknown';

        // Jupiter cross-check (best-effort)
        let jupiterInfo = '';
        try {
          const unitAmount = Math.pow(10, decimals);
          const otherMintBuy = (buy.pool.baseMint === mint) ? buy.pool.quoteMint : buy.pool.baseMint;
          const out1 = await getJupiterOutAmount(mint, otherMintBuy, unitAmount);
          if (out1) jupiterInfo = `\nJupiter sample out: ${out1}`;
        } catch {}

        const msg =
`💰 *Arbitrage Opportunity*
Token: *${symbol}* (\`${mint}\`)
Buy pool: \`${buyId}\` — price ${buy.price.toFixed(8)}
Sell pool: \`${sellId}\` — price ${sell.price.toFixed(8)}
Spread: *${spreadPct.toFixed(2)}%*${jupiterInfo}

_This is a detector only — it will not execute trades._`;

        console.log(`ALERT: ${symbol} spread ${spreadPct.toFixed(2)}% — buy ${buyId} sell ${sellId}`);
        await telegramSend(msg);
      }
    }
  } catch (err) {
    console.error('❌ scanArbOnce failed:', err.message);
  }
}

// ---------- Startup & schedule ----------
async function startup() {
  await refreshFilteredPools();
  setInterval(refreshFilteredPools, 15 * 60 * 1000); // refresh every 15m
  setInterval(scanArbOnce, SCAN_INTERVAL_MS);
  setTimeout(scanArbOnce, 3000);
}

// ---------- Express endpoints ----------
app.get('/', (req, res) => res.send('✅ Solana arbitrage detector running'));
app.post('/webhook', (req, res) => {
  const update = req.body;
  if (update?.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text?.trim();
    if (text === '/start') telegramSend('🤖 Bot online and scanning', chatId);
    else if (text === '/status') telegramSend(`📊 Status: watchlist ${watchlist.length} tokens, filteredPools ${filteredPools.length}`, chatId);
  }
  res.sendStatus(200);
});
app.post('/webhook/:token', (req, res) => { app._router.handle(req, res, () => {}); });

// ---------- Start server ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
  startup().catch(err => console.error('startup failed', err));
});

// safety
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
process.on('uncaughtException', (err) => { console.error('uncaughtException', err); process.exit(1); });
