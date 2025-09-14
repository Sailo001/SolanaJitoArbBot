// index.js
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
const PRIVATE_KEY_BASE58 = process.env.PRIVATE_KEY; // optional for detection-only mode
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = Number(process.env.PORT || 10000);
const SCAN_INTERVAL_MS = Math.max(Number(process.env.SCAN_INTERVAL_MS || 30000), 10000);
const JUPITER_TOKENS_API = 'https://quote-api.jup.ag/v7/tokens';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v7/quote';
const PROFIT_THRESHOLD_PCT = Number(process.env.PROFIT_THRESHOLD_PCT || 2.0);

// ----------------- SAFETY CHECKS -----------------
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set in environment');
  process.exit(1);
}

// ----------------- EXPRESS -----------------
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('✅ Solana Arbitrage Bot running'));

// ----------------- WALLET -----------------
let wallet = null;
try {
  if (PRIVATE_KEY_BASE58) {
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
    console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);
  }
} catch (err) {
  console.warn('⚠️ Failed to load PRIVATE_KEY. Running in detection-only mode.');
}

// ----------------- CONNECTION -----------------
const connection = new Connection(RPC_URL, 'confirmed');
console.log(`🌐 RPC: ${RPC_URL}`);

// ----------------- TELEGRAM -----------------
async function telegramSend(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    console.error('❌ Telegram send failed', err.message);
  }
}

// ----------------- ASYNC QUEUE -----------------
const scanQueue = new PQueue({ concurrency: 3 });

// ----------------- TOKEN CACHE -----------------
let jupiterTokens = [];
async function refreshJupiterTokens() {
  try {
    const res = await fetch(JUPITER_TOKENS_API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    jupiterTokens = json.data || [];
    console.log(`✅ Jupiter token cache loaded: ${jupiterTokens.length} tokens`);
  } catch (err) {
    console.error('❌ Failed to refresh Jupiter tokens:', err.message);
  }
}

// ----------------- ARBITRAGE DETECTION -----------------
async function scanArb(token) {
  try {
    const inputMint = token.address;
    const outputMints = jupiterTokens.map(t => t.address).filter(m => m !== inputMint);

    const quotes = [];
    for (const outputMint of outputMints) {
      const amount = Math.pow(10, token.decimals || 6); // 1 unit
      try {
        const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippage=1`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.data?.[0]?.outAmount) {
          quotes.push({ outputMint, outAmount: BigInt(data.data[0].outAmount) });
        }
      } catch {}
    }

    if (quotes.length < 2) return;

    quotes.sort((a, b) => Number(b.outAmount - a.outAmount));
    const bestSell = quotes[0];
    const bestBuy = quotes[quotes.length - 1];
    const spreadPct = Number((bestSell.outAmount - bestBuy.outAmount) * 100n / bestBuy.outAmount);

    if (spreadPct >= PROFIT_THRESHOLD_PCT) {
      const msg = `💰 *Arbitrage Opportunity Detected*
Token: *${token.symbol || inputMint}* (\`${inputMint}\`)
Best Buy Mint: \`${bestBuy.outputMint}\`
Best Sell Mint: \`${bestSell.outputMint}\`
Spread: *${spreadPct.toFixed(2)}%*

_Only detection — does not execute trades yet._`;
      console.log(msg.replace(/\*/g, ''));
      await telegramSend(msg);

      // Optional: queue for on-chain execution if wallet loaded
      if (wallet) {
        scanQueue.add(async () => {
          console.log(`⚡ MEV protected execution placeholder for ${token.symbol || inputMint}`);
          // TODO: implement Jupiter swap execution with MEV protection
        });
      }
    }
  } catch (err) {
    console.error(`❌ scanArb failed for ${token.symbol || token.address}:`, err.message);
  }
}

// ----------------- MAIN SCAN LOOP -----------------
async function scanAllTokens() {
  if (!jupiterTokens.length) {
    console.warn('⚠️ Token cache empty; refreshing...');
    await refreshJupiterTokens();
    if (!jupiterTokens.length) return;
  }

  console.log(`🔎 Scanning ${jupiterTokens.length} tokens for arbitrage opportunities`);
  for (const token of jupiterTokens) {
    scanQueue.add(() => scanArb(token));
  }
}

// ----------------- STARTUP -----------------
async function startup() {
  await refreshJupiterTokens();
  setInterval(refreshJupiterTokens, 15 * 60 * 1000); // refresh token cache every 15 min
  setInterval(scanAllTokens, SCAN_INTERVAL_MS);       // scan loop
  setTimeout(scanAllTokens, 5000);                   // initial scan
}

app.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
  startup().catch(err => console.error('❌ startup failed:', err));
});
