// index.js
// === Meme Coin Awakener Pipeline ===
// Solana Token List → Filtering → Liquidity Pools → Arbitrage → Telegram Alerts

import 'dotenv/config';
import fetch from 'node-fetch';
import { createServer } from 'http';

// === Telegram Settings ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// === Pipeline Constants ===
const SOLANA_TOKEN_LIST = 'https://token.jup.ag/strict'; // Jupiter token list
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/search?q=solana&page=1';
const POLL_INTERVAL = 30 * 1000; // 30 seconds

// === Helper: Send Telegram Alert ===
async function sendAlert(message) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// === Step 1: Fetch Token List ===
async function fetchTokenList() {
  try {
    const res = await fetch(SOLANA_TOKEN_LIST);
    return await res.json();
  } catch (e) {
    console.error('Token list fetch error:', e.message);
    return [];
  }
}

// === Step 2: Filter Meme Coins (basic: no logo, funny names) ===
function filterMemeCoins(tokens) {
  return tokens.filter(t => {
    const name = (t.name || '').toLowerCase();
    return !t.logoURI && (name.includes('dog') || name.includes('pepe') || name.includes('moon') || name.includes('cat'));
  });
}

// === Step 3: Check Liquidity Pools (via DexScreener) ===
async function fetchLiquidityPools() {
  try {
    const res = await fetch(DEXSCREENER_API);
    const data = await res.json();
    return data.pairs || [];
  } catch (e) {
    console.error('Liquidity fetch error:', e.message);
    return [];
  }
}

// === Step 4: Detect Arbitrage Opportunities ===
function detectArbitrage(pools) {
  const opps = [];
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const p1 = parseFloat(pools[i].priceUsd || 0);
      const p2 = parseFloat(pools[j].priceUsd || 0);
      if (!p1 || !p2) continue;
      const diff = Math.abs(p1 - p2) / Math.min(p1, p2);
      if (diff >= 0.05) { // ≥5% arbitrage
        opps.push({ baseToken: pools[i].baseToken?.symbol, p1, p2, diff });
      }
    }
  }
  return opps;
}

// === Step 5: Main Pipeline ===
async function pipeline() {
  console.log('🔄 Running pipeline...');

  const tokens = await fetchTokenList();
  const memes = filterMemeCoins(tokens);
  console.log(`🪙 Found ${memes.length} meme coins`);

  const pools = await fetchLiquidityPools();

  const opps = detectArbitrage(pools);
  if (opps.length > 0) {
    for (const opp of opps) {
      const msg = `🚀 *Arbitrage Detected!*\nToken: ${opp.baseToken}\nPrice1: $${opp.p1}\nPrice2: $${opp.p2}\nDiff: ${(opp.diff*100).toFixed(2)}%`;
      await sendAlert(msg);
    }
  } else {
    console.log('⚡ No arbitrage found');
  }
}

// === Schedule ===
setInterval(pipeline, POLL_INTERVAL);
pipeline(); // run immediately on start

// === Healthcheck for Render ===
const port = process.env.PORT || 3000;
createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(port, () => console.log(`🌍 Server running on port ${port}`));
