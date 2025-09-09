import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createServer } from 'http';
import { scanArb } from './src/arb.js';

const tokens = JSON.parse(fs.readFileSync("tokens.json", "utf-8"));
console.log("✅ Loaded", tokens.length, "tokens from tokens.json");

const bot = new Telegraf(process.env.TG_BOT_TOKEN);
const ADMIN = Number(process.env.ADMIN_ID);

const connection = new Connection(process.env.SOLANA_RPC, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

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
  ctx.reply("🔍 Scanning arbitrage opportunities ...");
  const opps = await scanArb(connection, tokens, 0.1); // 0.1 SOL leg
  if (opps.length === 0) {
    ctx.reply("❌ No profitable routes found (> 0.1 %).");
    return;
  }
  const msg = opps.map((o, i) =>
    `${i + 1}. **${o.symbol}**  →  **+${o.profitPc.toFixed(2)} %**  (**${o.profitSol.toFixed(4)} SOL**)`
  ).join('\n');
  ctx.replyWithMarkdown(`📊 Top opportunities (0.1 SOL leg):\n\n${msg}`);
});

bot.action("swap", async ctx => {
  await ctx.answerCbQuery();
  ctx.reply("⚡ Swap executor will be implemented here.");
});

const port = process.env.PORT || 3000;
createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200);
    res.end("Bot running ✅");
  }
}).listen(port, () => console.log(`🚀 Server listening on port ${port}`));

bot.launch();
