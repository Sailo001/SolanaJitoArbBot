// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import express from 'express';

// === CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 10000;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

let tokenCache = [];
let poolCache = [];

// === TELEGRAM ALERT ===
async function sendTelegramMessage(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return await res.json();
  } catch (err) {
    console.error(`❌ Telegram error: ${err.message}`);
  }
}

// === FETCH JUPITER TOKENS ===
async function loadJupiterTokens() {
  const url = 'https://token.jup.ag/all';
  console.log(`📡 Fetching Jupiter tokens...`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tokenCache = await res.json();
    console.log(`✅ Loaded ${tokenCache.length} tokens`);
  } catch (err) {
    console.error(`❌ Failed to load Jupiter tokens: ${err.message}`);
  }
}

// === FETCH RAYDIUM POOLS ===
async function loadRaydiumPools() {
  const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  console.log(`📡 Fetching Raydium pools (filtered)...`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    poolCache = Object.values(data).slice(0, 100); // limit 100 pools
    console.log(`✅ Loaded ${poolCache.length} pools`);
  } catch (err) {
    console.error(`❌ Failed to load Raydium pools: ${err.message}`);
  }
}

// === HELPER: Fetch Jupiter quote ===
async function getJupiterQuote(inputMint, outputMint, amount) {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.data || !data.data[0]) return null;
    return data.data[0].outAmount;
  } catch (err) {
    console.error(`❌ Jupiter quote failed: ${err.message}`);
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

  const samplePools = poolCache.slice(0, 10); // scan 10 per cycle

  for (const pool of samplePools) {
    const baseToken = tokenCache.find(t => t.address === pool.baseMint);
    const quoteToken = tokenCache.find(t => t.address === pool.quoteMint);
    if (!baseToken || !quoteToken) continue;

    const amount = 10 ** (baseToken.decimals || 6); // 1 unit

    const out1 = await getJupiterQuote(baseToken.address, quoteToken.address, amount);
    if (!out1) continue;

    const out2 = await getJupiterQuote(quoteToken.address, baseToken.address, out1);
    if (!out2) continue;

    const profitPct = ((out2 - amount) / amount * 100).toFixed(2);

    if (profitPct >= 5) {
      const message = `
🚨 Arbitrage Opportunity!
Pool: ${pool.id}
Base: ${baseToken.symbol} (${baseToken.address})
Quote: ${quoteToken.symbol} (${quoteToken.address})
💰 Profit Margin: +${profitPct}%
      `;
      console.log(message);
      await sendTelegramMessage(TELEGRAM_CHAT_ID, message);
    }
  }
}

// === MAIN LOOP ===
async function main() {
  console.log(`🚀 Starting Solana Arbitrage Bot...`);
  await loadJupiterTokens();
  await loadRaydiumPools();

  setInterval(scanArbitrage, 30_000); // scan every 30s
}

// === EXPRESS HEALTH SERVER ===
const app = express();
app.get('/', (req, res) => res.send('✅ Bot is running'));
app.listen(PORT, () => {
  console.log(`🌐 Health server listening on ${PORT}`);
});

// === START ===
main();
