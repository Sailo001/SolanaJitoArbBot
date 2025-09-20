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

// Store tokens and PnL
const tokens = [];
const pnlHistory = [];

// --------------------
// Telegram Commands & Inline Buttons
// --------------------

// Start command
bot.start((ctx) => {
  ctx.reply(
    "🤖 Dummy Flashloan Arb Bot started!\n\nUse /addtoken to submit a token contract address."
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

  await ctx.reply(
    `⚠️ You submitted token: ${token}`,
    Markup.inlineKeyboard([
      Markup.button.callback("✅ Confirm", `confirm_${token}`),
      Markup.button.callback("❌ Cancel", `cancel_${token}`),
      Markup.button.callback("⚡ Execute Flashloan", `flashloan_${token}`),
    ])
  );
});

// Handle inline buttons
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("confirm_")) {
    const token = data.split("_")[1];
    if (!tokens.includes(token)) tokens.push(token);
    const pnl = (Math.random() * 10).toFixed(2);
    pnlHistory.push({ token, pnl });
    await ctx.editMessageText(
      `✅ Token ${token} confirmed!\n💰 Dummy PnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history"),
        Markup.button.callback("⚡ Execute Flashloan", `flashloan_${token}`),
      ])
    );
  }

  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  if (data.startsWith("flashloan_")) {
    const token = data.split("_")[1];
    await ctx.answerCbQuery(`⚡ Executing flashloan for ${token}...`);
    
    try {
      const pnl = await executeFlashloan(token);
      await ctx.editMessageText(
        `⚡ Flashloan executed for ${token}!\n💰 Dummy PnL: $${pnl}`,
        Markup.inlineKeyboard([
          Markup.button.callback("📊 View History", "view_history"),
          Markup.button.callback("🗑 Clear History", "clear_history"),
          Markup.button.callback("⚡ Execute Flashloan", `flashloan_${token}`),
        ])
      );
    } catch (err) {
      await ctx.reply(`❌ Flashloan failed for ${token}. Check logs.`);
    }
  }

  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory.map((t) => `${t.token}: $${t.pnl}`).join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  if (data === "clear_history") {
    pnlHistory.length = 0;
    await ctx.answerCbQuery("History cleared!");
  }
});

// --------------------
// Dummy Flashloan Execution with MEV Protection
// --------------------
async function executeFlashloan(token) {
  try {
    console.log(`⚡ [MEV Safe] Preparing flashloan for ${token}...`);

    // STEP 1: Simulate checking current DEXs for token liquidity
    const dexes = ["Raydium", "Orca", "Lifinity"];
    console.log(`🔍 Checking liquidity across DEXs: ${dexes.join(", ")}`);

    // STEP 2: Simulate transaction bundle for MEV protection
    console.log(`🔒 Creating MEV-protected transaction bundle for ${token}...`);

    // STEP 3: Execute flashloan (dummy)
    const pnl = (Math.random() * 20 - 10).toFixed(2); // -10 to +10
    pnlHistory.push({ token, pnl });

    console.log(`✅ Flashloan executed for ${token} | Dummy PnL: $${pnl}`);
    return pnl;

  } catch (err) {
    console.error(`❌ Flashloan execution failed for ${token}:`, err);
    throw err;
  }
}

// Launch Telegram bot
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
