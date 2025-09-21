// index.js
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Store user selections
const tokenSelections = {};

// === Fetch price from Jupiter API restricted to specific DEX ===
async function getDexPrice(tokenMint, dex) {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=So11111111111111111111111111111111111111112&amount=1000000&onlyDirectRoutes=true&dexes[]=${dex}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data && data.data && data.data.length > 0) {
      // Convert to SOL price
      const outAmount = data.data[0].outAmount;
      const inAmount = data.data[0].inAmount;
      const price = outAmount / inAmount;
      return price;
    }
    return null;
  } catch (err) {
    console.error(`Error fetching price for ${dex}:`, err);
    return null;
  }
}

// === Start Command ===
bot.start((ctx) => {
  ctx.reply(
    '🚀 Welcome to SolanaJitoArbBot!\n\nSubmit a token contract address to begin.',
    Markup.inlineKeyboard([[Markup.button.callback('Submit Token Address', 'submit_token')]])
  );
});

// === Handle Submit Token ===
bot.action('submit_token', async (ctx) => {
  await ctx.reply('📩 Please send me the token contract address:');
});

// === Listen for token contract address ===
bot.on('text', async (ctx) => {
  const token = ctx.message.text.trim();

  // Initialize selection for this token
  tokenSelections[token] = { buyDex: null, sellDex: null, buyPrice: null, sellPrice: null };

  await ctx.reply(
    `✅ Token received: <code>${token}</code>\n\nSelect Buy DEX:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Raydium', `buydex_${token}_Raydium`)],
        [Markup.button.callback('Orca', `buydex_${token}_Orca`)],
        [Markup.button.callback('Lifinity', `buydex_${token}_Lifinity`)]
      ])
    }
  );
});

// === Handle Buy DEX Selection ===
bot.action(/buydex_(.+)_(.+)/, async (ctx) => {
  const token = ctx.match[1];
  const dex = ctx.match[2];

  tokenSelections[token].buyDex = dex;

  await ctx.editMessageText(
    `Buy DEX selected: ${dex}\nSelect Sell DEX:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Raydium', `selldex_${token}_Raydium`)],
      [Markup.button.callback('Orca', `selldex_${token}_Orca`)],
      [Markup.button.callback('Lifinity', `selldex_${token}_Lifinity`)]
    ])
  );
});

// === Handle Sell DEX Selection ===
bot.action(/selldex_(.+)_(.+)/, async (ctx) => {
  const token = ctx.match[1];
  const dex = ctx.match[2];

  if (!tokenSelections[token]) {
    tokenSelections[token] = {};
  }
  tokenSelections[token].sellDex = dex;

  const buyDex = tokenSelections[token].buyDex;

  // Fetch real prices from Jupiter
  const buyPrice = await getDexPrice(token, buyDex);
  const sellPrice = await getDexPrice(token, dex);

  tokenSelections[token].buyPrice = buyPrice;
  tokenSelections[token].sellPrice = sellPrice;

  let pnlText = '';
  if (buyPrice && sellPrice) {
    const pnl = ((sellPrice - buyPrice) / buyPrice) * 100;
    pnlText = `\n💰 Estimated PnL: ${pnl.toFixed(2)}%`;
  } else {
    pnlText = '\n⚠️ Could not fetch prices for one or both DEXs.';
  }

  await ctx.editMessageText(
    `Buy DEX selected: ${buyDex} @ $${buyPrice?.toFixed(6) || 'N/A'}\n` +
    `Sell DEX selected: ${dex} @ $${sellPrice?.toFixed(6) || 'N/A'}${pnlText}\n\n` +
    `➡️ Ready to execute flashloan?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Execute Flashloan', `flashloan_${token}`)]
    ])
  );
});

// === Dummy Flashloan Execution ===
bot.action(/flashloan_(.+)/, async (ctx) => {
  const token = ctx.match[1];
  const selection = tokenSelections[token];

  const buyDex = selection.buyDex;
  const sellDex = selection.sellDex;
  const buyPrice = selection.buyPrice;
  const sellPrice = selection.sellPrice;

  let pnlText = '';
  if (buyPrice && sellPrice) {
    const pnl = ((sellPrice - buyPrice) / buyPrice) * 100;
    pnlText = `${pnl.toFixed(2)}%`;
  } else {
    pnlText = 'N/A';
  }

  await ctx.reply(
    `🚀 Executing Flashloan!\n` +
    `Token: ${token}\n` +
    `Buy on: ${buyDex} @ $${buyPrice?.toFixed(6) || 'N/A'}\n` +
    `Sell on: ${sellDex} @ $${sellPrice?.toFixed(6) || 'N/A'}\n` +
    `Estimated PnL: ${pnlText}\n\n` +
    `✅ (Simulation only, no real execution)`
  );
});

// === Webhook Setup for Render ===
app.use(express.json());

app.post(`/webhook/${process.env.BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Bot is running 🚀');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Launch bot webhook
bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook/${process.env.BOT_TOKEN}`);
