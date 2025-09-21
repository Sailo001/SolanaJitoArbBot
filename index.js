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
const pnlHistory = [];

// Available DEXs for simulation
const DEX_LIST = ["Raydium", "Orca", "Lifinity"];

// --------------------
// Start Command
// --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Flashloan Arb Bot started!\n\nSubmit a token using /addtoken."
  );
});

// --------------------
// Add Token Command
// --------------------
bot.command("addtoken", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply("📄 Send me the token contract address:");
});

// --------------------
// Capture Token Addresses
// --------------------
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
// Handle Inline Buttons
// --------------------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Confirm Token
  if (data.startsWith("confirm_")) {
    const token = data.split("_")[1];
    if (!tokens.includes(token)) tokens.push(token);

    await ctx.editMessageText(
      `✅ Token ${token} confirmed! Choose Buy DEX:`,
      Markup.inlineKeyboard(
        DEX_LIST.map((dex) =>
          Markup.button.callback(dex, `buydex_${token}_${dex}`)
        ),
        { columns: 2 }
      )
    );
  }

  // Cancel Token
  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  // Buy DEX selection
  if (data.startsWith("buydex_")) {
    const [_, token, buyDex] = data.split("_");

    await ctx.editMessageText(
      `✅ Token: ${token}\nBuy DEX selected: ${buyDex}\nChoose Sell DEX:`,
      Markup.inlineKeyboard(
        DEX_LIST.filter((dex) => dex !== buyDex).map((dex) =>
          Markup.button.callback(`Sell: ${dex}`, `selldex_${token}_${buyDex}_${dex}`)
        ),
        { columns: 2 }
      )
    );
  }

  // Sell DEX selection
  if (data.startsWith("selldex_")) {
    const [_, token, buyDex, sellDex] = data.split("_");

    await ctx.editMessageText(
      `✅ Token: ${token}\nBuy DEX: ${buyDex}\nSell DEX: ${sellDex}\nExecute flashloan?`,
      Markup.inlineKeyboard([
        Markup.button.callback("💸 Execute Flashloan", `execute_${token}_${buyDex}_${sellDex}`),
      ])
    );
  }

  // Execute Flashloan (Dummy MEV Simulation)
  if (data.startsWith("execute_")) {
    const [_, token, buyDex, sellDex] = data.split("_");

    // MEV Simulation: Only proceed if profitable (dummy)
    const simulatedPnL = (Math.random() * 20 - 5).toFixed(2); // -5 to +15
    const isProfitable = simulatedPnL > 0;

    if (isProfitable) {
      pnlHistory.push({ token, buyDex, sellDex, pnl: simulatedPnL });
      await ctx.editMessageText(
        `🚀 Flashloan executed successfully!\nToken: ${token}\nBuy DEX: ${buyDex}\nSell DEX: ${sellDex}\nPnL: $${simulatedPnL}`
      );

      await bot.telegram.sendMessage(
        ADMIN_ID,
        `📈 Flashloan Executed!\nToken: ${token}\nBuy: ${buyDex}\nSell: ${sellDex}\nPnL: $${simulatedPnL}`
      );
    } else {
      await ctx.editMessageText(
        `⚠️ MEV Simulation: Not profitable, execution aborted.\nToken: ${token}\nBuy: ${buyDex}\nSell: ${sellDex}\nSimulated PnL: $${simulatedPnL}`
      );
    }
  }
});

// --------------------
// Launch Telegram Bot
// --------------------
bot.launch();
console.log("🤖 Flashloan Arb Bot started...");

// --------------------
// Healthcheck Server
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ Flashloan Arb Bot is running!");
});

app.listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});
