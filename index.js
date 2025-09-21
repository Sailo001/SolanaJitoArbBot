import { Telegraf, Markup } from "telegraf";
import express from "express";
import fetch from "node-fetch";

// --------------------
// Environment Variables
// --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error("⚠️ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_ID");
  process.exit(1);
}

// --------------------
// Telegram Bot Setup
// --------------------
const bot = new Telegraf(BOT_TOKEN);

// --------------------
// Data Storage
// --------------------
const tokens = [];
const pnlHistory = [];
const tokenSelections = {}; // { tokenAddress: { buyDex: null, sellDex: null } }

// --------------------
// Helper: Get Token Price
// --------------------
async function getTokenPrice(tokenAddress, dex) {
  try {
    let price = null;

    if (dex === "Raydium") {
      const res = await fetch(`https://api.raydium.io/v2/sdk/liquidity/mainnet.json`);
      const pools = await res.json();
      const pool = pools.find(p => p.baseMint === tokenAddress || p.quoteMint === tokenAddress);
      if (pool) price = pool.price || null;
    }

    if (dex === "Orca") {
      const res = await fetch(`https://api.orca.so/mainnet/pools`);
      const pools = await res.json();
      const pool = pools.find(p => p.tokenA === tokenAddress || p.tokenB === tokenAddress);
      if (pool) price = pool.price || null;
    }

    if (dex === "Lifinity") {
      const res = await fetch(`https://api.lifinity.io/pools`);
      const pools = await res.json();
      const pool = pools.find(p => p.tokenA === tokenAddress || p.tokenB === tokenAddress);
      if (pool) price = pool.price || null;
    }

    return price;
  } catch (err) {
    console.error(`⚠️ ${dex} fetch error:`, err.message);
    return null;
  }
}

// --------------------
// Bot Commands
// --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Flashloan Arb Bot started!\n\nUse /addtoken to submit a token contract address."
  );
});

bot.command("addtoken", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply("📄 Send me the token contract address:");
});

bot.on("text", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const token = ctx.message.text.trim();
  if (!token) return;

  tokenSelections[token] = { buyDex: null, sellDex: null };

  await ctx.reply(
    `⚠️ Token submitted: ${token}`,
    Markup.inlineKeyboard([
      Markup.button.callback("Select Buy DEX", `buy_${token}`),
      Markup.button.callback("Cancel", `cancel_${token}`)
    ])
  );
});

// --------------------
// Inline Button Handlers
// --------------------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Cancel token
  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    delete tokenSelections[token];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
    return;
  }

  // Buy DEX selection
  if (data.startsWith("buy_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(
      `Select Buy DEX for token ${token}:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Raydium", `buydex_${token}_Raydium`),
        Markup.button.callback("Orca", `buydex_${token}_Orca`),
        Markup.button.callback("Lifinity", `buydex_${token}_Lifinity`),
      ])
    );
    return;
  }

  if (data.startsWith("buydex_")) {
    const [_, token, dex] = data.split("_");
    tokenSelections[token].buyDex = dex;

    // Next step: select sell DEX
    await ctx.editMessageText(
      `Buy DEX selected: ${dex}\nSelect Sell DEX:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Raydium", `selldex_${token}_Raydium`),
        Markup.button.callback("Orca", `selldex_${token}_Orca`),
        Markup.button.callback("Lifinity", `selldex_${token}_Lifinity`),
      ])
    );
    return;
  }

  // Sell DEX selection
  if (data.startsWith("selldex_")) {
    const [_, token, dex] = data.split("_");
    tokenSelections[token].sellDex = dex;

    const buyDex = tokenSelections[token].buyDex;
    const buyPrice = await getTokenPrice(token, buyDex) || Math.random() * 100 + 50;
    const sellPrice = await getTokenPrice(token, dex) || Math.random() * 100 + 50;
    const pnl = (sellPrice - buyPrice).toFixed(2);
    pnlHistory.push({ token, pnl });

    await ctx.editMessageText(
      `✅ Token ${token} ready!\nBuy DEX: ${buyDex}\nSell DEX: ${dex}\n💰 Estimated PnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("💸 Execute Flashloan", `execute_${token}`),
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history"),
      ])
    );
    return;
  }

  // Execute Flashloan (dummy)
  if (data.startsWith("execute_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`⚡ Flashloan executed for token ${token} (dummy simulation).`);
    return;
  }

  // View PnL History
  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory.map(t => `${t.token}: $${t.pnl}`).join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
    return;
  }

  // Clear PnL History
  if (data === "clear_history") {
    pnlHistory.length = 0;
    await ctx.answerCbQuery("History cleared!");
    return;
  }
});

// --------------------
// Launch Bot
// --------------------
bot.launch();
console.log("🤖 Flashloan Arb Bot started...");

// --------------------
// Healthcheck Server
// --------------------
const app = express();
app.get("/", (req, res) => res.send("✅ Flashloan Arb Bot is running!"));
app.listen(PORT, () => console.log(`🌍 Healthcheck server listening on port ${PORT}`));
