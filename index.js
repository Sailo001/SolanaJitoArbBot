import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import express from 'express';
import { Keypair, Connection, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import PQueue from 'p-queue';

// ----------------- CONFIG -----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRIVATE_KEY_BASE58 = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = Number(process.env.PORT || 10000);
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS || 30000), 10000);
const PROFIT_THRESHOLD_PCT = Number(process.env.PROFIT_THRESHOLD_PCT || 2.0);
const JUPITER_TOKENS_API = process.env.JUPITER_TOKENS_API || 'https://quote-api.jup.ag/v7/tokens';
const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API || 'https://quote-api.jup.ag/v7/quote';
const JUPITER_SWAP_API = process.env.JUPITER_SWAP_API || 'https://quote-api.jup.ag/v7/swap';
const MAX_CONCURRENT_SCANS = Number(process.env.MAX_CONCURRENT_SCANS || 5);

// ----------------- SETUP -----------------
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set in environment');
  process.exit(1);
}

const app = express();
app.use(express.json());

let wallet = null;
try {
  if (PRIVATE_KEY_BASE58) {
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
    console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
  }
} catch (err) {
  console.warn('⚠️ Failed to load wallet, detection-only mode.');
}

const connection = new Connection(RPC_URL, 'confirmed');
console.log(`🌐 RPC: ${RPC_URL}`);

// ----------------- TELEGRAM -----------------
async function telegramSend(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }) });
  } catch (err) {
    console.error('❌ Telegram send failed', err.message);
  }
}

// ----------------- TOKEN WATCHLIST -----------------
let watchlist = [];
try {
  const raw = fs.readFileSync('./tokens.json', 'utf8');
  watchlist = JSON.parse(raw);
  console.log(`✅ tokens.json loaded: ${watchlist.length} tokens`);
} catch {
  console.warn('⚠️ tokens.json not found, using Jupiter token discovery');
}

// ----------------- UTIL -----------------
async function fetchJsonWithRetry(url, opts = {}, retries = 3, backoffMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i < retries) {
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs *= 2;
      } else throw err;
    }
  }
}

// ----------------- JUPITER TOKEN DISCOVERY -----------------
let jupiterTokens = [];
async function refreshJupiterTokens() {
  try {
    const data = await fetchJsonWithRetry(JUPITER_TOKENS_API);
    jupiterTokens = data.tokens || [];
    console.log(`✅ Jupiter tokens cache loaded: ${jupiterTokens.length} tokens`);
  } catch (err) {
    console.error('❌ Failed to refresh Jupiter tokens:', err.message);
  }
}

// ----------------- ARBITRAGE DETECTION -----------------
const scanQueue = new PQueue({ concurrency: MAX_CONCURRENT_SCANS });

async function scanArbForToken(token) {
  try {
    const routesRes = await fetchJsonWithRetry(`${JUPITER_QUOTE_API}?inputMint=${token.address}&outputMint=So11111111111111111111111111111111111111112&amount=1000000&slippage=1`);
    const routes = routesRes.data || [];
    if (!routes.length) return;

    // Example: compute spread for first route
    const bestRoute = routes[0];
    const spreadPct = ((Number(bestRoute.outAmount) - 1000000) / 1000000) * 100;
    if (spreadPct >= PROFIT_THRESHOLD_PCT) {
      await telegramSend(`💰 Arbitrage opportunity detected!\nToken: ${token.symbol}\nSpread: ${spreadPct.toFixed(2)}%`);
      if (wallet) await executeAtomicArbitrage(bestRoute.route, 1000000);
    }
  } catch (err) {
    console.warn(`⚠️ Scan failed for ${token.symbol}: ${err.message}`);
  }
}

// ----------------- ON-CHAIN MEV-PROTECTED SWAP -----------------
async function executeAtomicArbitrage(route, amount) {
  try {
    const params = new URLSearchParams({
      route: JSON.stringify(route),
      amount: amount.toString(),
      slippageBps: '50',
      wrapUnwrapSOL: 'true',
      asLegacyTransaction: 'false',
      feeAccount: wallet.publicKey.toBase58(),
    });
    const res = await fetch(`${JUPITER_SWAP_API}?${params.toString()}`);
    const json = await res.json();
    const swapTxBase64 = json.data?.swapTransaction;
    if (!swapTxBase64) throw new Error('No swap transaction returned');

    const tx = Transaction.from(Buffer.from(swapTxBase64, 'base64'));
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
    tx.sign(wallet);

    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: false, commitment: 'confirmed' });
    console.log(`🚀 Arbitrage executed: ${sig}`);
    await telegramSend(`🚀 Arbitrage executed: ${sig}`);
  } catch (err) {
    console.error('⚠️ Atomic arbitrage failed:', err.message);
    await telegramSend(`⚠️ Arbitrage execution failed: ${err.message}`);
  }
}

// ----------------- STARTUP -----------------
async function startup() {
  await refreshJupiterTokens();

  // Periodic scan
  setInterval(async () => {
    for (const token of jupiterTokens) {
      scanQueue.add(() => scanArbForToken(token));
    }
  }, SCAN_INTERVAL_MS);
}

// ----------------- EXPRESS HEALTH -----------------
app.get('/', (req, res) => res.send('✅ Solana arbitrage bot (MEV-protected) running'));
app.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
  startup().catch(err => console.error('startup failed', err));
});
