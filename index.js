import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN);

// === Utility to safely fetch JSON ===
async function safeFetchJson(url, name) {
  try {
    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) throw new Error(`${name} returned HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      console.error(`⚠️ ${name} JSON parse failed:`, text.slice(0, 120));
      throw err;
    }
  } catch (err) {
    console.error(`⚠️ ${name} fetch error`, err.message);
    return null;
  }
}

// === Raydium ===
async function getRaydiumPrice() {
  const data = await safeFetchJson(
    'https://api.raydium.io/v2/amm/price?mint1=So11111111111111111111111111111111111111112&mint2=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'Raydium'
  );
  return data?.price ?? null;
}

// === Orca ===
async function getOrcaPrice() {
  const data = await safeFetchJson('https://api.orca.so/allPools', 'Orca');
  if (!data || !data.whirlpool) return null;
  const pool = Object.values(data.whirlpool).find(
    (p) =>
      (p.tokenA.mint === 'So11111111111111111111111111111111111111112' &&
        p.tokenB.mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') ||
      (p.tokenB.mint === 'So11111111111111111111111111111111111111112' &&
        p.tokenA.mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
  );
  return pool?.price ?? null;
}

// === Lifinity ===
async function getLifinityPrice() {
  const data = await safeFetchJson(
    'https://api.lifinity.io/price/SOLUSDC',
    'Lifinity'
  );
  return data?.price ?? null;
}

// === Meteora ===
async function getMeteoraPrice() {
  const data = await safeFetchJson(
    'https://api.meteora.ag/markets/price?pair=SOLUSDC',
    'Meteora'
  );
  return data?.price ?? null;
}

// === Scanner ===
async function scanArbitrage() {
  console.log('🔍 Scanning SOL/USDC across DEXs...');

  const [raydium, orca, lifinity, meteora] = await Promise.all([
    getRaydiumPrice(),
    getOrcaPrice(),
    getLifinityPrice(),
    getMeteoraPrice(),
  ]);

  const prices = { Raydium: raydium, Orca: orca, Lifinity: lifinity, Meteora: meteora };
  console.log('📊 Prices:', prices);

  const validPrices = Object.entries(prices).filter(([_, v]) => v);
  if (validPrices.length < 2) return;

  const values = validPrices.map(([_, v]) => v);
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (max - min > 0.5) {
    const msg = `🚨 Arbitrage opportunity!\nBuy at ${min}, sell at ${max}`;
    console.log(msg);
    bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, msg);
  }
}

// === Start Loop ===
setInterval(scanArbitrage, 10000);

console.log('✅ Bot started and scanning every 10s...');
