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
// Bot Commands
// --------------------

// Start
bot.start((ctx) => {
  ctx.reply(
    "🤖 Dummy MEV Flashloan Arb Bot started!\n\nUse /addtoken to submit a token contract address."
  );
});

// Add token
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
      Markup.button.callback("✅ Confirm Token", `confirm_${token}`),
      Markup.button.callback("❌ Cancel", `cancel_${token}`),
    ])
  );
});

// Inline button handlers
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("confirm_")) {
    const token = data.split("_")[1];
    if (!tokens.includes(token)) tokens.push(token);

    await ctx.editMessageText(
      `✅ Token ${token} confirmed!`,
      Markup.inlineKeyboard([
        Markup.button.callback("💥 Simulate Flashloan", `simulate_${token}`),
        Markup.button.callback("🗑 Remove Token", `remove_${token}`),
      ])
    );
  }

  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  if (data.startsWith("simulate_")) {
    const token = data.split("_")[1];
    // Dummy MEV simulation
    const pnl = (Math.random() * 25 - 5).toFixed(2); // -5 to +20 USD
    pnlHistory.push({ token, pnl });

    const canExecute = pnl > 0;
    await ctx.editMessageText(
      `📊 Flashloan Simulation Result\nToken: ${token}\nPotential PnL: $${pnl}\nExecution Status: ${
        canExecute ? "✅ Can Execute" : "❌ Skip Execution"
      }`,
      Markup.inlineKeyboard([
        Markup.button.callback(
          "⚡ Execute Flashloan",
          canExecute ? `execute_${token}` : `skip_${token}`
        ),
        Markup.button.callback("📊 View PnL History", "view_history"),
      ])
    );
  }

  if (data.startsWith("execute_")) {
    const token = data.split("_")[1];
    const pnl = (Math.random() * 20 + 1).toFixed(2); // Dummy execution result
    pnlHistory.push({ token, pnl });

    await ctx.editMessageText(
      `💥 Flashloan Executed!\nToken: ${token}\nPnL Earned: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("📊 View PnL History", "view_history"),
      ])
    );

    // Telegram alert
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `💥 Flashloan Executed!\nToken: ${token}\nDummy PnL: $${pnl}`
    );
  }

  if (data.startsWith("skip_")) {
    await ctx.editMessageText("❌ Execution skipped due to negative/low simulation PnL.");
  }

  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory.map((t) => `${t.token}: $${t.pnl}`).join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  if (data.startsWith("remove_")) {
    const token = data.split("_")[1];
    const index = tokens.indexOf(token);
    if (index > -1) tokens.splice(index, 1);
    await ctx.editMessageText(`🗑 Token ${token} removed.`);
  }
});

// Launch bot
bot.launch();
console.log("🤖 Dummy MEV Flashloan Arb Bot started...");

// --------------------
// Healthcheck Server
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ Dummy MEV Flashloan Arb Bot is running!");
});

app.listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});
