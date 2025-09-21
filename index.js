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

// Store tokens, DEX choices, and PnL
const tokens = [];
const userState = {}; // Tracks state per user
const pnlHistory = [];

// Available DEXs
const DEX_LIST = ["Raydium", "Orca", "Lifinity"];

// --------------------
// Start command
// --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Dummy Flashloan Arb Bot started!\n\nUse /addtoken to submit a token contract address."
  );
});

// --------------------
// Add token command
// --------------------
bot.command("addtoken", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  userState[ctx.from.id] = { stage: "awaiting_token" };
  ctx.reply("📄 Send me the token contract address:");
});

// --------------------
// Capture token addresses
// --------------------
bot.on("text", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const state = userState[ctx.from.id];
  if (!state || state.stage !== "awaiting_token") return;

  const token = ctx.message.text.trim();
  if (!token) return;

  state.token = token;
  state.stage = "select_buy_dex";

  await ctx.reply(
    `⚠️ You submitted token: ${token}\nChoose Buy DEX:`,
    Markup.inlineKeyboard(
      DEX_LIST.map((dex) => Markup.button.callback(dex, `buy_${dex}`)),
      { columns: 3 }
    )
  );
});

// --------------------
// Handle inline buttons
// --------------------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const state = userState[ctx.from.id];
  if (!state) return;

  // Buy DEX selection
  if (data.startsWith("buy_") && state.stage === "select_buy_dex") {
    state.buyDEX = data.split("_")[1];
    state.stage = "select_sell_dex";

    await ctx.editMessageText(
      `✅ Buy DEX: ${state.buyDEX}\nNow select Sell DEX:`,
      Markup.inlineKeyboard(
        DEX_LIST.map((dex) => Markup.button.callback(dex, `sell_${dex}`)),
        { columns: 3 }
      )
    );
  }

  // Sell DEX selection
  if (data.startsWith("sell_") && state.stage === "select_sell_dex") {
    state.sellDEX = data.split("_")[1];
    state.stage = "ready_execute";

    await ctx.editMessageText(
      `✅ Token: ${state.token}\n✅ Buy DEX: ${state.buyDEX}\n✅ Sell DEX: ${state.sellDEX}`,
      Markup.inlineKeyboard([
        Markup.button.callback("💸 Execute Flashloan", "execute_flashloan"),
      ])
    );
  }

  // Execute Flashloan
  if (data === "execute_flashloan" && state.stage === "ready_execute") {
    const token = state.token;
    const buyDEX = state.buyDEX;
    const sellDEX = state.sellDEX;
    const pnl = (Math.random() * 20 - 10).toFixed(2); // Dummy PnL
    pnlHistory.push({ token, buyDEX, sellDEX, pnl });

    await ctx.editMessageText(
      `🚀 Executed dummy flashloan!\nToken: ${token}\nBuy: ${buyDEX}\nSell: ${sellDEX}\n💰 Dummy PnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history"),
      ])
    );

    delete userState[ctx.from.id]; // Reset user state
  }

  // View history
  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory
        .map(
          (t) =>
            `${t.token} | Buy: ${t.buyDEX} | Sell: ${t.sellDEX} | PnL: $${t.pnl}`
        )
        .join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  // Clear history
  if (data === "clear_history") {
    pnlHistory.length = 0;
    await ctx.answerCbQuery("History cleared!");
  }
});

// --------------------
// Launch Telegram bot
// --------------------
bot.launch();
console.log("🤖 Dummy Flashloan Arb Bot started...");

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
