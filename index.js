// index.js – SOL-Arb-Bot – admin only – finds routes automatically
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fetch from 'node-fetch';
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import winston from 'winston';
import { createFlashBorrowInstruction, createFlashRepayInstruction } from './solend.js';
import { submitJitoBundle } from './jito.js';

// ---------- logger ----------
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'bot.log' })]
});

// ---------- env ----------
const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID      = process.env.TELEGRAM_ADMIN_ID;
const DOMAIN        = process.env.DOMAIN;
const PORT          = process.env.PORT || 10000;
const SOLANA_RPC    = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'grpc.mainnet.jito.sh:443';
const WALLET_PK     = process.env.WALLET_PRIVATE_KEY;
const JITO_API_KEY  = process.env.JITO_API_KEY;

const TX_FEE          = 0.000005; // per sig
const FLASH_LOAN_FEE  = 1;        // bps
const JITO_TIP        = 0.001;    // SOL
const SLIPPAGE        = 50;       // bps

if (!BOT_TOKEN || !ADMIN_ID || !DOMAIN || !WALLET_PK) {
  logger.error('Missing env'); process.exit(1);
}

// ---------- setup ----------
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
const connection = new Connection(SOLANA_RPC, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PK));

app.get('/', (_, res) => res.send('✅ Solana Arb Bot (mainnet)'));
app.listen(PORT, async () => {
  logger.info(`Server on ${PORT}`);
  await bot.telegram.setWebhook(`${DOMAIN}/webhook/${BOT_TOKEN}`).catch(logger.error);
});

// ---------- admin ----------
const isAdmin = ctx => ctx.from.id.toString() === ADMIN_ID;

// ---------- decimals ----------
async function getDec(mint) {
  try { return (await getMint(connection, new PublicKey(mint))).decimals; }
  catch { return null; }
}

// ---------- quote ----------
async function jupQuote(inputMint, outputMint, amount, retries = 3) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE}&onlyDirectRoutes=false`;
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (r.ok && j.data?.length) return j;
      if (r.status === 429) await new Promise(res => setTimeout(res, i * 300));
    } catch (e) { logger.warn(`quote ${i}: ${e.message}`); }
  }
  return null;
}

// ---------- build routes ----------
async function buildRoutes(tokenMint, usdSize = 10) {
  const dec = await getDec(tokenMint);
  if (!dec) return [];

  // 10 USDC -> token lamports
  const usdcLamports = Math.floor(usdSize * 10 ** 6);
  // 10 USDC worth of SOL -> SOL lamports
  const solLamports = Math.floor(usdSize * 1e9); // ≈ 10 SOL

  const [buyQ, sellQ] = await Promise.all([
    jupQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenMint, usdcLamports),
    jupQuote(tokenMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', Math.floor(usdSize * 10 ** dec))
  ]);
  if (!buyQ || !sellQ) return [];

  const out = [];
  for (const b of buyQ.data) {
    for (const s of sellQ.data) {
      const buyDex  = b.routePlan[0]?.swapInfo?.label ?? 'Unknown';
      const sellDex = s.routePlan[0]?.swapInfo?.label ?? 'Unknown';

      const buyOut  = Number(b.outAmount) / 10 ** dec;      // token received
      const sellOut = Number(s.outAmount) / 1e6;            // USDC received

      const flashFee = (usdSize * FLASH_LOAN_FEE) / 10000; // USDC
      const totalFee = flashFee + (TX_FEE * 3) + JITO_TIP; // approx USDC
      const profit = sellOut - usdSize - totalFee;

      out.push({ buyDex, sellDex, profit, buyRoute: b, sellRoute: s, size: usdSize });
    }
  }
  out.sort((a, b) => b.profit - a.profit);
  return out;
}

// ---------- execute ----------
async function execute(mint, buyRoute, sellRoute, size) {
  try {
    const dec = await getDec(mint);
    if (!dec) throw new Error('bad decimals');

    const flashFee = (size * FLASH_LOAN_FEE) / 10000;
    if (sellRoute.outAmount / 1e6 - size - flashFee - (TX_FEE * 3) - JITO_TIP <= 0) return false;

    const tx = new Transaction();
    tx.add(await createFlashBorrowInstruction(connection, size, wallet.publicKey));

    const [buyIx, sellIx] = await Promise.all([
      fetch('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: buyRoute, userPublicKey: wallet.publicKey.toString() })
      }).then(r => r.json()),
      fetch('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: sellRoute, userPublicKey: wallet.publicKey.toString() })
      }).then(r => r.json())
    ]);
    if (buyIx.error || sellIx.error) throw new Error('swap-ix');
    tx.add(...buyIx.instructions, ...sellIx.instructions);
    tx.add(await createFlashRepayInstruction(connection, size + flashFee, wallet.publicKey));

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const ser = tx.serialize().toString('base64');
    await submitJitoBundle({ transactions: [ser], tip: JITO_TIP }, JITO_ENDPOINT, JITO_API_KEY);
    return true;
  } catch (e) { logger.error(`exec: ${e.message}`); return false; }
}

// ---------- telegram ----------
bot.start(ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌');
  ctx.reply('🚀 Send any SPL-mint and I find the best 10-USDC round-trip.');
});

bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌');
  const mint = ctx.message.text.trim();
  try { new PublicKey(mint); } catch { return ctx.reply('❌ Bad mint'); }

  await ctx.reply('🔍 Searching …');
  const routes = await buildRoutes(mint);
  if (!routes.length) return ctx.reply('❌ No liquid routes');
  const top = routes.slice(0, 3);
  if (top[0].profit <= 0) return ctx.reply('📉 No profit after fees');

  let m = `✅ Best 10-USDC routes for *${mint.slice(0, 8)}…* :\n`;
  const kb = [];
  top.forEach((r, i) => {
    m += `\n${i + 1}. *${r.buyDex}* ➜ *${r.sellDex}*  (+${r.profit.toFixed(4)} USDC)`;
    kb.push([Markup.button.callback(`${i + 1}. ${r.buyDex}→${r.sellDex}`, `exec:${mint}:${i}`)]);
  });
  ctx.reply(m, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action(/exec:(.+):(\d)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌');
  const mint = ctx.match[1];
  const idx  = Number(ctx.match[2]);
  const routes = await buildRoutes(mint);
  if (!routes[idx]) return ctx.answerCbQuery('❌ route gone');
  const r = routes[idx];
  ctx.reply('🚀 Executing …');
  const ok = await execute(mint, r.buyRoute, r.sellRoute, r.size);
  ctx.reply(ok ? '✅ Bundle submitted' : '❌ Exec failed – logs');
  ctx.answerCbQuery();
});

bot.launch();
logger.info('Bot launched');
