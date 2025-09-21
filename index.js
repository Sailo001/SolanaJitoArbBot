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

// Store tokens, DEX selections, and PnL
const tokens = [];
const tokenSelections = {};
const pnlHistory = [];

// Start command
bot.start((ctx) => {
  ctx.reply(
    "🤖 Flashloan Arb Bot (Dummy Execution Mode) started!\n\nUse /addtoken to submit a token contract address."
  );
});

// Add token command
bot.command("addtoken", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply("📄 Send me the token contract address:");
});

// Capture token addresses
bot.on("text", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const token = ctx.message.text.trim();
  if (!token) return;

  if (!tokenSelections[token]) tokenSelections[token] = { buyDex: null, sellDex: null };

  await ctx.reply(
    `⚠️ You submitted token: ${token}`,
    Markup.inlineKeyboard([
      Markup.button.callback("✅ Confirm", `confirm_${token}`),
      Markup.button.callback("❌ Cancel", `cancel_${token}`),
    ])
  );
});

// Handle inline buttons
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Confirm token
  if (data.startsWith("confirm_")) {
    const token = data.split("_")[1];
    if (!tokens.includes(token)) tokens.push(token);

    // Ask for Buy DEX selection
    await ctx.editMessageText(
      `✅ Token ${token} confirmed!\nSelect Buy DEX:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Raydium", `buydex_${token}_Raydium`),
        Markup.button.callback("Orca", `buydex_${token}_Orca`),
        Markup.button.callback("Lifinity", `buydex_${token}_Lifinity`),
      ])
    );
  }

  // Cancel token
  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  // Buy DEX selection
  if (data.startsWith("buydex_")) {
    const [, token, dex] = data.split("_");
    if (!tokenSelections[token]) tokenSelections[token] = { buyDex: null, sellDex: null };
    tokenSelections[token].buyDex = dex;

    // Ask for Sell DEX selection
    await ctx.editMessageText(
      `Buy DEX selected: ${dex}\nSelect Sell DEX:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Raydium", `selldex_${token}_Raydium`),
        Markup.button.callback("Orca", `selldex_${token}_Orca`),
        Markup.button.callback("Lifinity", `selldex_${token}_Lifinity`),
      ])
    );
  }

  // Sell DEX selection
  if (data.startsWith("selldex_")) {
    const [, token, dex] = data.split("_");
    if (!tokenSelections[token]) tokenSelections[token] = { buyDex: null, sellDex: null };
    tokenSelections[token].sellDex = dex;

    // Show Execute Flashloan button
    await ctx.editMessageText(
      `Buy DEX: ${tokenSelections[token].buyDex}\nSell DEX: ${dex}\nReady to execute flashloan (dummy mode)`,
      Markup.inlineKeyboard([
        Markup.button.callback("⚡ Execute Flashloan", `execflash_${token}`),
      ])
    );
  }

  // Execute Flashloan (dummy)
  if (data.startsWith("execflash_")) {
    const token = data.split("_")[1];
    const pnl = (Math.random() * 20 - 10).toFixed(2); // -10 to +10
    pnlHistory.push({ token, pnl });

    await ctx.editMessageText(
      `⚡ Flashloan executed (dummy) for ${token}\nPnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history"),
      ])
    );

    // Send Telegram alert
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📈 Dummy Flashloan Executed!\nToken: ${token}\nPnL: $${pnl}`
    );
  }

  // View history
  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory.map((t) => `${t.token}: $${t.pnl}`).join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  // Clear history
  if (data === "clear_history") {
    pnlHistory.length = 0;
    await ctx.answerCbQuery("History cleared!");
  }
});

// Launch Telegram bot
bot.launch();
console.log("🤖 Flashloan Arb Bot (Dummy Execution) started...");

// --------------------
// Healthcheck Server
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ Flashloan Arb Bot (Dummy Execution) is running!");
});

app.listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});
