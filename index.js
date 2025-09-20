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

const tokens = []; // Stores tokens
const pnlHistory = []; // Stores PnL history
const dexChoices = ["Orca", "Raydium", "Jupiter"];

// --------------------
// Start command
// --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Flashloan Arb Bot started!\nUse /addtoken to submit a token contract address."
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

// --------------------
// Inline Button Handling
// --------------------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Confirm Token
  if (data.startsWith("confirm_")) {
    const token = data.split("_")[1];
    if (!tokens.includes(token)) tokens.push(token);

    // Ask for Buy DEX
    await ctx.editMessageText(
      `✅ Token ${token} confirmed!\nSelect Buy DEX:`,
      Markup.inlineKeyboard(
        dexChoices.map((dex) => Markup.button.callback(dex, `buy_${token}_${dex}`))
      )
    );
  }

  // Cancel Token
  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  // Select Buy DEX
  if (data.startsWith("buy_")) {
    const [_, token, buyDex] = data.split("_");
    await ctx.editMessageText(
      `✅ Buy DEX: ${buyDex}\nSelect Sell DEX:`,
      Markup.inlineKeyboard(
        dexChoices.map((dex) => Markup.button.callback(`sell_${token}_${buyDex}_${dex}`, dex))
      )
    );
  }

  // Select Sell DEX
  if (data.startsWith("sell_")) {
    const [_, token, buyDex, sellDex] = data.split("_");
    await ctx.editMessageText(
      `✅ Buy: ${buyDex} | Sell: ${sellDex}\nReady to execute flashloan?`,
      Markup.inlineKeyboard([
        Markup.button.callback(`execute_${token}_${buyDex}_${sellDex}`, "Execute Flashloan"),
      ])
    );
  }

  // Execute Flashloan (dummy MEV simulation for now)
  if (data.startsWith("execute_")) {
    const [_, token, buyDex, sellDex] = data.split("_");
    const pnl = (Math.random() * 20 - 10).toFixed(2); // Dummy PnL
    pnlHistory.push({ token, buyDex, sellDex, pnl });

    await ctx.editMessageText(
      `⚡ Flashloan executed!\nToken: ${token}\nBuy: ${buyDex}\nSell: ${sellDex}\nPnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history"),
      ])
    );

    // Send alert
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📈 Flashloan executed!\nToken: ${token}\nBuy: ${buyDex}\nSell: ${sellDex}\nPnL: $${pnl}`
    );
  }

  // View history
  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory
        .map((t) => `${t.token} | ${t.buyDex}->${t.sellDex}: $${t.pnl}`)
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
// Launch Bot
// --------------------
bot.launch();
console.log("🤖 Flashloan Arb Bot started...");

// --------------------
// Healthcheck Server
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Flashloan Arb Bot is running!"));
app.listen(PORT, () => console.log(`🌍 Healthcheck server listening on port ${PORT}`));
