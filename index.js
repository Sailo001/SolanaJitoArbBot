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

// Store tokens, DEX selection, and PnL
const tokens = [];
const pnlHistory = [];
const tokenDEXMap = {}; // { token: { buyDEX, sellDEX } }

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

  // Confirm token submission
  if (data.startsWith("confirm_")) {
    const token = data.split("_")[1];
    if (!tokens.includes(token)) tokens.push(token);

    // Ask user to select Buy DEX
    await ctx.editMessageText(
      `✅ Token ${token} confirmed!\nSelect Buy DEX:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Raydium", `buy_${token}_Raydium`),
        Markup.button.callback("Orca", `buy_${token}_Orca`),
        Markup.button.callback("Lifinity", `buy_${token}_Lifinity`),
      ])
    );
  }

  // Cancel token submission
  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  // Buy DEX selection
  if (data.startsWith("buy_")) {
    const [_, token, buyDEX] = data.split("_");
    tokenDEXMap[token] = { buyDEX };
    await ctx.editMessageText(
      `📌 Token: ${token}\nBuy DEX selected: ${buyDEX}\nSelect Sell DEX:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Raydium", `sell_${token}_Raydium`),
        Markup.button.callback("Orca", `sell_${token}_Orca`),
        Markup.button.callback("Lifinity", `sell_${token}_Lifinity`),
      ])
    );
  }

  // Sell DEX selection
  if (data.startsWith("sell_")) {
    const [_, token, sellDEX] = data.split("_");
    tokenDEXMap[token].sellDEX = sellDEX;

    await ctx.editMessageText(
      `📌 Token: ${token}\nBuy DEX: ${tokenDEXMap[token].buyDEX}\nSell DEX: ${sellDEX}\nReady to Execute Flashloan`,
      Markup.inlineKeyboard([
        Markup.button.callback("🚀 Execute Flashloan", `flashloan_${token}`),
      ])
    );
  }

  // Execute Flashloan (MEV simulation)
  if (data.startsWith("flashloan_")) {
    const token = data.split("_")[1];
    const { buyDEX, sellDEX } = tokenDEXMap[token];

    // Dummy MEV simulation
    const buyPrice = Math.random() * 10 + 100; // 100-110
    const sellPrice = Math.random() * 10 + 100; // 100-110
    const pnl = (sellPrice - buyPrice - Math.random() * 2).toFixed(2); // minus dummy fees

    let resultMsg;
    if (pnl > 0) {
      resultMsg = `✅ Flashloan executed!\nToken: ${token}\nBuy DEX: ${buyDEX}\nSell DEX: ${sellDEX}\n💰 Simulated PnL: $${pnl}`;
      pnlHistory.push({ token, pnl });
    } else {
      resultMsg = `⚠️ Flashloan aborted – not profitable\nToken: ${token}\nBuy DEX: ${buyDEX}\nSell DEX: ${sellDEX}\nSimulated loss: $${pnl}`;
    }

    await ctx.editMessageText(resultMsg, Markup.inlineKeyboard([
      Markup.button.callback("📊 View History", "view_history"),
      Markup.button.callback("🗑 Clear History", "clear_history"),
    ]));
  }

  // View PnL history
  if (data === "view_history") {
    if (pnlHistory.length === 0) {
      await ctx.answerCbQuery("No history yet.");
    } else {
      const msg = pnlHistory.map((t) => `${t.token}: $${t.pnl}`).join("\n");
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  // Clear PnL history
  if (data === "clear_history") {
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
