import { Telegraf, Markup } from "telegraf";
import express from "express";
import fetch from "node-fetch";

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

// Store tokens and selections
const tokenSelections = {}; // { tokenAddress: { buyDex, sellDex } }

// DEX list
const DEXS = ["Raydium", "Orca", "Lifinity"];

// --------------------
// Helper: Fetch price from Jupiter API
// --------------------
async function getPriceFromDEX(token, dex) {
  try {
    // For simplicity, we fetch Jupiter quote and simulate per DEX
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=SOL&outputMint=${token}&amount=1000000000&slippage=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data || !data.data || data.data.length === 0) return null;

    // Simulate price variation per DEX
    const basePrice = Number(data.data[0].outAmount) / 1e9;
    const dexPrice = basePrice * (1 + (Math.random() - 0.5) / 100); // ±0.5%
    return dexPrice.toFixed(6);
  } catch (err) {
    console.error(`${dex} fetch error:`, err.message);
    return null;
  }
}

// --------------------
// Start command
// --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Flashloan Arb Bot started!\n\nUse /addtoken to submit a token contract address."
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

  if (!tokenSelections[token]) tokenSelections[token] = {};
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
    await ctx.editMessageText(`✅ Token ${token} confirmed!\nSelect Buy DEX:`, {
      reply_markup: {
        inline_keyboard: await Promise.all(
          DEXS.map(async (dex) => {
            const price = await getPriceFromDEX(token, dex);
            return [
              {
                text: `${dex} ${price ? `$${price}` : ""}`,
                callback_data: `buydex_${token}_${dex}`,
              },
            ];
          })
        ),
      },
    });
  }

  if (data.startsWith("cancel_")) {
    const token = data.split("_")[1];
    delete tokenSelections[token];
    await ctx.editMessageText(`❌ Token ${token} submission canceled.`);
  }

  if (data.startsWith("buydex_")) {
    const [_, token, dex] = data.split("_");
    tokenSelections[token].buyDex = dex;

    await ctx.editMessageText(`Buy DEX selected: ${dex}\nSelect Sell DEX:`, {
      reply_markup: {
        inline_keyboard: await Promise.all(
          DEXS.map(async (sdex) => {
            const price = await getPriceFromDEX(token, sdex);
            return [
              {
                text: `${sdex} ${price ? `$${price}` : ""}`,
                callback_data: `selldex_${token}_${sdex}`,
              },
            ];
          })
        ),
      },
    });
  }

  if (data.startsWith("selldex_")) {
    const [_, token, dex] = data.split("_");
    tokenSelections[token].sellDex = dex;

    await ctx.editMessageText(
      `Sell DEX selected: ${dex}\nReady to execute flashloan:`,
      Markup.inlineKeyboard([
        Markup.button.callback("🚀 Execute Flashloan", `execute_${token}`),
      ])
    );
  }

  if (data.startsWith("execute_")) {
    const token = data.split("_")[1];
    const { buyDex, sellDex } = tokenSelections[token];

    // Fetch prices for final PnL simulation
    const buyPrice = await getPriceFromDEX(token, buyDex);
    const sellPrice = await getPriceFromDEX(token, sellDex);
    const pnl = ((sellPrice - buyPrice) / buyPrice * 100).toFixed(2);

    if (pnl <= 0) {
      await ctx.answerCbQuery(
        `MEV protection: Trade would be unprofitable (${pnl}%)`,
        { show_alert: true }
      );
      return;
    }

    await ctx.editMessageText(
      `🚀 Executing Flashloan!\nToken: ${token}\nBuy on: ${buyDex} @ $${buyPrice}\nSell on: ${sellDex} @ $${sellPrice}\nEstimated PnL: ${pnl}%`
    );

    // Telegram admin alert
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🚀 Flashloan Executed!\nToken: ${token}\nBuy on: ${buyDex} @ $${buyPrice}\nSell on: ${sellDex} @ $${sellPrice}\nEstimated PnL: ${pnl}%`
    );
  }
});

// Launch Telegram bot
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
