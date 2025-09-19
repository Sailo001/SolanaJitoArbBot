import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

// === CONFIG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID; // Your Telegram user/group ID
const SCAN_INTERVAL = 15000; // 15 sec
const SPREAD_THRESHOLD = 0.05; // 5%

// Tokens to track
const TOKENS = [
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xkvrCNQ6qLFDs9X" },
  { symbol: "WIF", mint: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E" },
  { symbol: "JUP", mint: "JUPy6d7sY3WxH1Rz9PxQhDq5d6GvYLMdQhCxpFw9KY" },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCo6f6y7JpRkNv9d7tvda3z5GD" },
  { symbol: "SRM", mint: "SRMuApVNdxXokk5GT7P9w9kG9t8zAtQ4vxzsQjM1s3k" },
  { symbol: "SAMO", mint: "7xKXtg2QXyNJ7tFGSrNKd9Kr6xWbcV27XgZzY6f7nqXS" },
  { symbol: "FIDA", mint: "EchesyfXePKdLtoiZSL8pBe8u3hG6vCAuMMm6RbnFJ7s" }
];

// DEX list
const DEXES = ["Raydium", "Orca", "Lifinity", "Meteora"];

// Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// === DEX API call (via Jupiter with onlyDexes filter) ===
async function getPrice(mint, dex) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&onlyDexes=${dex}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.outAmount) {
      return Number(data.outAmount) / 1e6; // Convert lamports to USDC price
    }
    return null;
  } catch (err) {
    console.error(`Error fetching price for ${mint} on ${dex}:`, err.message);
    return null;
  }
}

// === Arbitrage detection ===
async function checkArbitrage() {
  for (const token of TOKENS) {
    // fetch all prices in parallel
    const prices = {};
    await Promise.all(
      DEXES.map(async (dex) => {
        prices[dex] = await getPrice(token.mint, dex);
      })
    );

    // compare every pair of DEXs
    for (let i = 0; i < DEXES.length; i++) {
      for (let j = i + 1; j < DEXES.length; j++) {
        const dexA = DEXES[i];
        const dexB = DEXES[j];
        const priceA = prices[dexA];
        const priceB = prices[dexB];

        if (priceA && priceB) {
          // check buy at A, sell at B
          const spreadAB = (priceB - priceA) / priceA;
          if (spreadAB >= SPREAD_THRESHOLD) {
            await bot.telegram.sendMessage(
              CHAT_ID,
              `🚨 Arbitrage Found!\nToken: ${token.symbol}\nBuy @ ${dexA}: $${priceA}\nSell @ ${dexB}: $${priceB}\nSpread: ${(spreadAB * 100).toFixed(2)}%`
            );
          }

          // check buy at B, sell at A
          const spreadBA = (priceA - priceB) / priceB;
          if (spreadBA >= SPREAD_THRESHOLD) {
            await bot.telegram.sendMessage(
              CHAT_ID,
              `🚨 Arbitrage Found!\nToken: ${token.symbol}\nBuy @ ${dexB}: $${priceB}\nSell @ ${dexA}: $${priceA}\nSpread: ${(spreadBA * 100).toFixed(2)}%`
            );
          }
        }
      }
    }
  }
}

// === Start bot ===
bot.launch();
console.log("🤖 Arbitrage bot started...");

setInterval(checkArbitrage, SCAN_INTERVAL);
import http from 'http';

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Arbitrage bot is running!\n');
}).listen(PORT, () => {
  console.log(`🌍 Healthcheck server running on port ${PORT}`);
});
