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

// Jupiter Aggregator token cache
const JUPITER_TOKENS_API = 'https://quote-api.jup.ag/v6/tokens';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';

// ----------------- SAFETY CHECKS -----------------
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set');
  process.exit(1);
}

// ----------------- SETUP -----------------
const app = express();
app.use(express.json());

// Load watchlist
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

// Load wallet (optional)
let wallet = null;
try {
  if (PRIVATE_KEY_BASE58) {
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
    console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
  }
} catch {
  console.warn('⚠️ Failed to load PRIVATE_KEY — continuing detection-only mode');
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

// ----------------- FETCH HELPERS -----------------
async function fetchJsonWithRetry(url, retries = 3, backoffMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        console.warn(`⚠️ fetch failed (${attempt}/${retries}): ${url} -> ${err.message}, retry in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs *= 2;
        continue;
      }
      throw err;
    }
  }
}

// ----------------- JUPITER POOL PRICES -----------------
let tokenMap = new Map(); // mint -> token info

async function refreshTokenCache() {
  try {
    const json = await fetchJsonWithRetry(JUPITER_TOKENS_API, 4, 3000);
    tokenMap = new Map();
    for (const t of json.data || []) {
      tokenMap.set(t.address, t);
    }
    console.log(`✅ Jupiter tokens loaded: ${tokenMap.size}`);
  } catch (err) {
    console.error('❌ Failed to refresh Jupiter token cache:', err.message);
  }
}

// Get Jupiter quote
async function getJupiterQuote(inputMint, outputMint, amountSmallestUnit) {
  try {
    const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountSmallestUnit}&slippage=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.data?.[0]?.outAmount) return null;
    return Number(json.data[0].outAmount);
  } catch {
    return null;
  }
}

// ----------------- ARBITRAGE DETECTION -----------------
async function scanArbOnce() {
  console.log(`🔎 Scanning ${watchlist.length} tokens for arbitrage opportunities`);

  for (const tk of watchlist) {
    const mint = tk.mint || tk.address;
    const decimals = Number(tk.decimals ?? 6);
    const symbol = tk.symbol || mint.slice(0,6);

    // Attempt to quote token -> USDC and USDC -> token for crude arbitrage
    const unitAmount = Math.pow(10, decimals);

    const out1 = await getJupiterQuote(mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', unitAmount); // token -> USDC
    const out2 = await getJupiterQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', mint, out1 ?? 0); // USDC -> token

    if (out1 && out2) {
      const spreadPct = ((out2 - unitAmount) / unitAmount) * 100;
      if (spreadPct >= PROFIT_THRESHOLD_PCT) {
        const msg = `💰 Arbitrage Opportunity Detected\nToken: *${symbol}*\nSpread: *${spreadPct.toFixed(2)}%*\nOnly a detector — does not execute trades.`;
        console.log(msg.replace(/\*/g,''));
        await telegramSend(msg);
      }
    }
  }
}

// ----------------- STARTUP LOOP -----------------
async function startup() {
  await refreshTokenCache();
  setInterval(refreshTokenCache, 15*60*1000); // refresh cache every 15 min
  setInterval(scanArbOnce, SCAN_INTERVAL_MS);
  setTimeout(scanArbOnce, 3000);
}

// ----------------- EXPRESS -----------------
app.get('/', (req,res) => res.send('✅ Solana Arbitrage Detector Running'));
app.post(`/webhook/${TELEGRAM_TOKEN}`, (req,res) => res.sendStatus(200));

app.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
  startup().catch(err => console.error('❌ startup failed', err));
});
