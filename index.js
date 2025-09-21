// index.js
// Solana Arbitrage Bot (dummy execution mode)

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fetch from 'node-fetch';

// === ENVIRONMENT VARIABLES ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const DOMAIN = process.env.DOMAIN; // e.g. https://your-app.onrender.com
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !ADMIN_ID || !DOMAIN) {
  console.error("❌ Missing environment variables. Check TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ID, DOMAIN");
  process.exit(1);
}

// === TELEGRAM BOT SETUP ===
const bot = new Telegraf(BOT_TOKEN);

// === EXPRESS SERVER FOR WEBHOOK ===
const app = express();
app.use(express.json());

// Webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ Solana Arbitrage Bot is running');
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(`${DOMAIN}/webhook/${BOT_TOKEN}`);
    console.log("✅ Webhook set successfully");
  } catch (err) {
    console.error("❌ Failed to set webhook:", err.message);
  }
});

// === HELPER: Fetch Jupiter Prices ===
async function getPrices(mintAddress, baseMint = "So11111111111111111111111111111111111111112") {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint}&outputMint=${mintAddress}&amount=1000000&slippageBps=50&onlyDirectRoutes=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.data || data.data.length === 0) return [];

    return data.data.map(route => ({
      dex: route.marketInfos[0].amm.label,
      price: route.outAmount / 1e6, // normalize to USDC decimals
    }));
  } catch (err) {
    console.error("❌ Error fetching Jupiter prices:", err.message);
    return [];
  }
}

// === HELPER: Detect Arbitrage Opportunities ===
function detectArbitrage(prices) {
  if (prices.length < 2) return null;

  let bestBuy = prices.reduce((a, b) => (a.price < b.price ? a : b));
  let bestSell = prices.reduce((a, b) => (a.price > b.price ? a : b));

  if (bestSell.price <= bestBuy.price) return null;

  const pnl = ((bestSell.price - bestBuy.price) / bestBuy.price) * 100;
  return { bestBuy, bestSell, pnl: pnl.toFixed(2) };
}

// === TELEGRAM COMMANDS ===
bot.start(ctx => {
  ctx.reply("🚀 Welcome to SolanaJitoArbBot!\nSend me a token mint address to check arbitrage opportunities.");
});

bot.on("text", async ctx => {
  const tokenMint = ctx.message.text.trim();
  ctx.reply(`🔍 Checking arbitrage for token: \`${tokenMint}\`...`, { parse_mode: "Markdown" });

  const prices = await getPrices(tokenMint);
  if (prices.length === 0) {
    return ctx.reply("❌ No prices found. Token may be illiquid.");
  }

  const arb = detectArbitrage(prices);
  if (!arb) {
    return ctx.reply("⚠️ No arbitrage opportunity detected.");
  }

  ctx.reply(
    `💹 *Arbitrage Found!*\n\n` +
    `Buy on: *${arb.bestBuy.dex}* @ $${arb.bestBuy.price.toFixed(6)}\n` +
    `Sell on: *${arb.bestSell.dex}* @ $${arb.bestSell.price.toFixed(6)}\n` +
    `Estimated PnL: *${arb.pnl}%*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Execute Trade", `exec_${tokenMint}`)],
        [Markup.button.callback("📊 Show Stats", `stats_${tokenMint}`)]
      ])
    }
  );
});

// === TELEGRAM CALLBACKS ===
bot.on("callback_query", async ctx => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("exec_")) {
    const tokenMint = data.split("_")[1];
    await ctx.reply(`🚀 Executing Flashloan (dummy mode)\nToken: ${tokenMint}\n⚡️ Trade simulated.`);
  }

  if (data.startsWith("stats_")) {
    const tokenMint = data.split("_")[1];
    const prices = await getPrices(tokenMint);
    if (prices.length === 0) {
      return ctx.reply("❌ No stats available.");
    }
    let msg = `📊 *DEX Prices for ${tokenMint}:*\n`;
    prices.forEach(p => {
      msg += `- ${p.dex}: $${p.price.toFixed(6)}\n`;
    });
    await ctx.reply(msg, { parse_mode: "Markdown" });
  }

  ctx.answerCbQuery();
});
