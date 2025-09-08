// index.js
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fetch from 'node-fetch';
import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createServer } from 'http';

// === Load tokens.json ===
const tokens = JSON.parse(fs.readFileSync("tokens.json", "utf-8"));
console.log("✅ Loaded", tokens.length, "tokens from tokens.json");

// === Telegram bot setup ===
const bot = new Telegraf(process.env.TG_BOT_TOKEN);
const ADMIN = Number(process.env.ADMIN_ID);

// === Solana connection ===
const connection = new Connection(process.env.SOLANA_RPC, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

// === Commands ===
bot.start(ctx => {
  ctx.reply(
    `🤖 Meme Coin Arbitrage Bot Ready!\n\nLoaded ${tokens.length} tokens.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🔍 Scan Arbitrage", "scan")],
      [Markup.button.callback("💸 Execute Swap", "swap")]
    ])
  );
});

bot.action("scan", async ctx => {
  await ctx.answerCbQuery();
  ctx.reply("🔍 Scanning tokens for arbitrage opportunities...");

  // Example: just listing tokens now
  const list = tokens.map(t => `• ${t.symbol}`).join("\n");
  ctx.reply(`📊 Watching ${tokens.length} tokens:\n\n${list}`);
});

bot.action("swap", async ctx => {
  await ctx.answerCbQuery();
  ctx.reply("⚡ Swap executor will be implemented here.");
});

// === Health check server (for Render) ===
const port = process.env.PORT || 3000;
createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200);
    res.end("Bot running ✅");
  }
}).listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});

// === Start bot ===
bot.launch();
