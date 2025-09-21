import { Telegraf, Markup } from "telegraf";
import express from "express";

// --------------------
// Environment Variables
// --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error("⚠️ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_ID");
  process.exit(1);
}

// --------------------
// Telegram Bot Setup
// --------------------
const bot = new Telegraf(BOT_TOKEN);

// Token storage
const tokenMap = {}; // { id: token_address }
let tokenCounter = 0;

// PnL storage
const pnlHistory = [];

// --------------------
// Commands
// --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Dummy Flashloan Arb Bot started!\n\nUse /addtoken to submit a token contract address."
  );
});

bot.command("addtoken", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply("📄 Send me the token contract address:");
});

// --------------------
// Capture token submission
// --------------------
bot.on("text", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const token = ctx.message.text.trim();
  if (!token) return;

  tokenCounter++;
  const id = `T${tokenCounter}`;
  tokenMap[id] = token;

  const dexOptions = ["Raydium", "Orca", "Lifinity"]; // Dummy DEXs

  await ctx.reply(
    `⚠️ You submitted token: ${token}`,
    Markup.inlineKeyboard(
      dexOptions.map((dex) => Markup.button.callback(dex, `buydex_${id}_${dex}`))
    )
  );
});

// --------------------
// Callback Query Handler
// --------------------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("buydex_")) {
    const [_, id, buyDex] = data.split("_");
    const token = tokenMap[id];

    // After choosing buy DEX, show Sell DEX options
    const sellDexOptions = ["Raydium", "Orca", "Lifinity"].filter((d) => d !== buyDex);
    await ctx.editMessageText(
      `✅ Token: ${token}\nBuy DEX: ${buyDex}\nChoose Sell DEX:`,
      Markup.inlineKeyboard(
        sellDexOptions.map((dex) => Markup.button.callback(dex, `selldex_${id}_${buyDex}_${dex}`))
      )
    );
  }

  if (data.startsWith("selldex_")) {
    const [_, id, buyDex, sellDex] = data.split("_");
    const token = tokenMap[id];

    // Show Execute Flashloan button
    await ctx.editMessageText(
      `✅ Token: ${token}\nBuy DEX: ${buyDex}\nSell DEX: ${sellDex}\nReady to execute?`,
      Markup.inlineKeyboard([
        Markup.button.callback("🚀 Execute Flashloan", `execute_${id}_${buyDex}_${sellDex}`)
      ])
    );
  }

  if (data.startsWith("execute_")) {
    const [_, id, buyDex, sellDex] = data.split("_");
    const token = tokenMap[id];

    // Dummy PnL generation
    const pnl = (Math.random() * 20 - 10).toFixed(2);
    pnlHistory.push({ token, buyDex, sellDex, pnl });

    await ctx.editMessageText(
      `✅ Flashloan executed for ${token}\nBuy: ${buyDex} | Sell: ${sellDex}\n💰 Dummy PnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history")
      ])
    );
  }

  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory
        .map((t) => `${t.token}: Buy-${t.buyDex} | Sell-${t.sellDex} | $${t.pnl}`)
        .join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  if (data === "clear_history") {
    pnlHistory.length = 0;
    await ctx.answerCbQuery("History cleared!");
  }
});

// --------------------
// Launch Bot
// --------------------
bot.launch();
console.log("🤖 Dummy Flashloan Arb Bot started...");

// --------------------
// Dummy Scan Loop (Optional Telegram Alerts)
// --------------------
const SCAN_INTERVAL = 15000; // 15s
setInterval(async () => {
  if (Object.keys(tokenMap).length === 0) return;

  console.log("🔍 Scanning tokens for dummy arbitrage...");
  for (const id of Object.keys(tokenMap)) {
    const token = tokenMap[id];
    const pnl = (Math.random() * 20 - 10).toFixed(2);
    pnlHistory.push({ token, buyDex: "Raydium", sellDex: "Orca", pnl });

    // Telegram alert
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📈 Dummy Arbitrage Alert!\nToken: ${token}\nBuy: Raydium | Sell: Orca\nPnL: $${pnl}`
    );

    console.log(`📈 Token: ${token} | Dummy PnL: $${pnl}`);
  }
}, SCAN_INTERVAL);

// --------------------
// Healthcheck Server
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ Dummy Flashloan Arb Bot is running!");
});

app.listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});
