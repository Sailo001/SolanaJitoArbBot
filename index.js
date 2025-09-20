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

// Store tokens, buy/sell DEX, and PnL
const tokens = []; // { token, buyDex, sellDex, pnl }
const pnlHistory = [];

const DEXS = ["Raydium", "Orca", "Lifinity"];

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
    // Ask to choose Buy DEX
    await ctx.editMessageText(
      `✅ Token ${token} confirmed! Choose Buy DEX:`,
      Markup.inlineKeyboard(
        DEXS.map((dex) => Markup.button.callback(dex, `buydex_${token}_${dex}`))
      )
    );
  }

  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  if (data.startsWith("buydex_")) {
    const [, token, buyDex] = data.split("_");
    // Ask to choose Sell DEX (exclude Buy DEX)
    const sellOptions = DEXS.filter((dex) => dex !== buyDex);
    await ctx.editMessageText(
      `📌 Buy DEX: ${buyDex}\nChoose Sell DEX:`,
      Markup.inlineKeyboard(
        sellOptions.map((dex) => Markup.button.callback(`Sell: ${dex}`, `selldex_${token}_${buyDex}_${dex}`))
      )
    );
  }

  if (data.startsWith("selldex_")) {
    const [, token, buyDex, sellDex] = data.split("_");
    const pnl = (Math.random() * 20 - 10).toFixed(2); // Dummy PnL
    tokens.push({ token, buyDex, sellDex, pnl });
    pnlHistory.push({ token, buyDex, sellDex, pnl });

    await ctx.editMessageText(
      `💰 Token: ${token}\nBuy DEX: ${buyDex}\nSell DEX: ${sellDex}\nDummy PnL: $${pnl}`,
      Markup.inlineKeyboard([
        Markup.button.callback("Execute Flashloan", `execute_${token}`),
        Markup.button.callback("📊 View History", "view_history"),
        Markup.button.callback("🗑 Clear History", "clear_history"),
      ])
    );
  }

  if (data.startsWith("execute_")) {
    const token = data.split("_")[1];
    const t = tokens.find((t) => t.token === token);
    if (!t) return;

    // Dummy execution alert
    await ctx.editMessageText(
      `⚡ Executing flashloan for token: ${token}\nBuy from: ${t.buyDex}\nSell to: ${t.sellDex}\nExpected PnL: $${t.pnl}`
    );
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `⚡ Dummy Flashloan Executed!\nToken: ${token}\nBuy DEX: ${t.buyDex}\nSell DEX: ${t.sellDex}\nPnL: $${t.pnl}`
    );
  }

  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory
        .map((t) => `${t.token} | Buy: ${t.buyDex} | Sell: ${t.sellDex} | PnL: $${t.pnl}`)
        .join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  if (data === "clear_history") {
    tokens.length = 0;
    pnlHistory.length = 0;
    await ctx.answerCbQuery("History cleared!");
  }
});

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
