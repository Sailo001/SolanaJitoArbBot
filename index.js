// index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Telegraf } from 'telegraf';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// ===== ENV =====
const {
  SOLANA_RPC = 'https://rpc.helius.xyz/?api-key=REPLACE_WITH_YOUR_KEY',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SCAN_INTERVAL_MS = '15000',
  PROFIT_PERCENT_THRESHOLD = '0.8', // percent profit required to alert
  TOKENS_FILE = './tokens.json'
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment for alerts.');
}

// Jupiter quote API base
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v4/quote';

// Small helpers
const parseIntSafe = (s, d) => { const n = parseInt(s); return Number.isFinite(n) ? n : d; };
const parseFloatSafe = (s, d) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d; };

const scanInterval = parseIntSafe(SCAN_INTERVAL_MS, 15000);
const profitThresholdPercent = parseFloatSafe(PROFIT_PERCENT_THRESHOLD, 0.8);

// Telegram
const bot = TELEGRAM_BOT_TOKEN ? new Telegraf(TELEGRAM_BOT_TOKEN) : null;
async function tgSend(text) {
  if (!bot) {
    console.log('TG not configured:', text);
    return;
  }
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (e) {
    console.error('TG send failed', e?.message || e);
  }
}

// Solana connection (read-only for quotes)
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Load tokens list
function loadTokens() {
  try {
    const p = path.resolve(TOKENS_FILE);
    if (!fs.existsSync(p)) {
      console.error('tokens.json not found at', p);
      return [];
    }
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    console.error('Failed to load tokens.json', e);
    return [];
  }
}

// Ask Jupiter for a quote A -> B for given amountA (in base units)
async function jupiterQuote(tokenIn, tokenOut, amountInBase) {
  // amountInBase is integer in token decimals (e.g., lamports for SOL)
  try {
    const url = `${JUPITER_QUOTE_API}?inputMint=${encodeURIComponent(tokenIn)}&outputMint=${encodeURIComponent(tokenOut)}&amount=${amountInBase}&slippage=1`;
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data && res.data.data && res.data.data.length > 0) {
      // Jupiter returns array of route objects; pick the top one
      return res.data.data[0];
    } else {
      return null;
    }
  } catch (e) {
    console.error('jupiterQuote error', e?.message || e);
    return null;
  }
}

// Convert decimal amount to base units (integer)
function toBase(amountFloat, decimals) {
  const factor = BigInt(10) ** BigInt(decimals);
  const scaled = BigInt(Math.floor(amountFloat * (10 ** decimals)));
  return scaled;
}

// Roundtrip simulation: A -> B -> A
async function simulateRoundtrip(pair) {
  // pair: { tokenA, tokenB, decimalsA, decimalsB, amountA }
  const decimalsA = pair.decimalsA ?? 9;
  const decimalsB = pair.decimalsB ?? 6;
  const amountAfloat = pair.amountA ?? 0.1;

  // amount in base units
  const amountAbase = toBase(amountAfloat, decimalsA).toString();

  // Quote A -> B
  const qAB = await jupiterQuote(pair.tokenA, pair.tokenB, amountAbase);
  if (!qAB) return null;

  // amount out from A->B (string integer)
  const amountBOut = qAB.outAmount; // in base units (string)
  const amountBfloat = Number(amountBOut) / (10 ** decimalsB);

  // Now quote B -> A using amountBOut
  const qBA = await jupiterQuote(pair.tokenB, pair.tokenA, amountBOut);
  if (!qBA) return null;

  const amountAround = BigInt(qBA.outAmount); // integer in A base units
  const amountAroundFloat = Number(amountAround) / (10 ** decimalsA);

  // Profit calculation
  const profitAbsolute = amountAroundFloat - amountAfloat;
  const profitPercent = (profitAbsolute / amountAfloat) * 100;

  return {
    pair: pair.symbol,
    inputAmountA: amountAfloat,
    intermediateB: amountBfloat,
    finalAmountA: amountAroundFloat,
    profitAbsolute,
    profitPercent,
    routeAB: qAB,
    routeBA: qBA
  };
}

// Scanner loop
let scanning = false;
async function doScan() {
  if (scanning) return;
  scanning = true;
  try {
    const tokens = loadTokens();
    if (tokens.length === 0) {
      console.log('No tokens configured. Edit tokens.json and redeploy.');
      scanning = false;
      return;
    }
    for (const pair of tokens) {
      try {
        const result = await simulateRoundtrip(pair);
        if (!result) {
          console.log(`[${pair.symbol}] no route or quote`);
          continue;
        }
        const short = `${pair.symbol} | in: ${result.inputAmountA} -> mid: ${result.intermediateB.toFixed(6)} -> final: ${result.finalAmountA.toFixed(6)} | profit%: ${result.profitPercent.toFixed(4)}`;
        console.log(short);

        if (result.profitPercent >= profitThresholdPercent) {
          const msg = `🚨 Arb candidate on Solana\nPair: ${pair.symbol}\nInput: ${result.inputAmountA} ${pair.symbol.split('/')[0]}\nIntermediate: ${result.intermediateB.toFixed(6)} ${pair.symbol.split('/')[1]}\nFinal: ${result.finalAmountA.toFixed(6)} ${pair.symbol.split('/')[0]}\nProfit: ${result.profitAbsolute.toFixed(6)} (${result.profitPercent.toFixed(4)}%)\n\nRoutes:\nA->B hops: ${result.routeAB.route?.map(r => r.marketInfos?.map(m => m.label).join(' | ')).slice(0,1)}\nB->A hops: ${result.routeBA.route?.map(r => r.marketInfos?.map(m => m.label).join(' | ')).slice(0,1)}\n\n*This is a simulation based on Jupiter quotes.*`;
          await tgSend(msg);
        }
      } catch (e) {
        console.error('pair scan error', e?.message || e);
      }
    }
  } finally {
    scanning = false;
  }
}

// Express health route and start
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`Solana arb scanner listening on ${port}. Scanning every ${scanInterval}ms`);
  // start scanning loop
  setInterval(doScan, scanInterval);
});

if (bot) {
  bot.start((ctx) => ctx.reply('Solana arb scanner active.'));
  bot.launch();
}
