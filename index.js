import express from "express";
import { Telegraf, Markup } from "telegraf";

// --------------------
// Environment Variables
// --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-render-url.com/webhook
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !ADMIN_ID || !WEBHOOK_URL) {
  console.error("⚠️ Missing TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ID or WEBHOOK_URL");
  process.exit(1);
}

// --------------------
// Telegram Bot Setup
// --------------------
const bot = new Telegraf(BOT_TOKEN);

// Store tokens and PnL
const tokens = [];
const pnlHistory = [];

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
      ])
    );
  }

  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
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
// Dummy Scan Loop with Telegram Alerts
// --------------------
const SCAN_INTERVAL = 15000; // 15 seconds

setInterval(async () => {
  if (tokens.length === 0) return;
  console.log("🔍 Scanning tokens for dummy arbitrage...");

  for (const token of tokens) {
    const pnl = (Math.random() * 20 - 10).toFixed(2); // -10 to +10
    pnlHistory.push({ token, pnl });

    // Telegram alert
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📈 Dummy Arbitrage Alert!\nToken: ${token}\nPnL: $${pnl}`
    );

    console.log(`📈 Token: ${token} | Dummy PnL: $${pnl}`);
  }
}, SCAN_INTERVAL);

// --------------------
// Express Server & Webhook
// --------------------
const app = express();

// Healthcheck
app.get("/", (req, res) => {
  res.send("✅ Dummy Flashloan Arb Bot is running!");
});

// Telegram webhook endpoint
app.use(express.json());
app.post("/webhook", (req, res) => {
  bot.handleUpdate(req.body, res).catch(console.error);
  res.sendStatus(200);
});

// Set webhook
bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`).then(() => {
  console.log(`🌍 Webhook set to: ${WEBHOOK_URL}/webhook`);
});

app.listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
  console.log("🤖 Dummy Flashloan Arb Bot started in webhook mode...");
});
