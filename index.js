// index.js – SOL-USDC arb – admin only – skips broken SOL→token quote
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

// ---------- config ----------
const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID      = process.env.TELEGRAM_ADMIN_ID;
const DOMAIN        = process.env.DOMAIN;
const PORT          = process.env.PORT || 10000;
const SOLANA_RPC    = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'grpc.mainnet.jito.sh:443';
const WALLET_PK     = process.env.WALLET_PRIVATE_KEY;
const JITO_API_KEY  = process.env.JITO_API_KEY;

const SIZE_USD      = 20;          // test size
const TX_FEE        = 0.000005;    // per sig
const FLASH_BPS     = 1;           // bps
const JITO_TIP      = 0.001;       // SOL
const SLIPPAGE      = 50;          // bps

if (!BOT_TOKEN || !ADMIN_ID || !DOMAIN || !WALLET_PK) {
  winston.error('Missing env'); process.exit(1);
}

// ---------- setup ----------
const logger = winston.createLogger({ level: 'info', format: winston.format.json(), transports: [new winston.transports.Console()] });
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
const connection = new Connection(SOLANA_RPC, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PK));

app.get('/', (_, res) => res.send('✅ Arb-Bot (mainnet)'));
app.listen(PORT, () => logger.info(`Port ${PORT}`));
bot.telegram.setWebhook(`${DOMAIN}/webhook/${BOT_TOKEN}`).catch(logger.error);

// ---------- helpers ----------
const isAdmin = ctx => ctx.from.id.toString() === ADMIN_ID;
const getDec  = async mint => (await getMint(connection, new PublicKey(mint))).decimals;

async function jupQuote(inputMint, outputMint, amount) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE}&onlyDirectRoutes=false`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = await r.json();
    return r.ok && j.data?.length ? j : null;
  } catch { return null; }
}

// ---------- build ----------
async function build(mint, usd = SIZE_USD) {
  const dec = await getDec(mint);
  if (!dec) return [];

  // 1. TOKEN → USDC  (always works)
  const sellQ = await jupQuote(mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', Math.floor(usd * 10 ** dec));
  if (!sellQ) return [];

  // 2. use *same* route to infer price for SOL → token
  const usdPerToken = Number(sellQ.data[0].outAmount) / 1e6 / (Math.floor(usd * 10 ** dec) / 10 ** dec); // USD / token
  const tokenPerUsd = 1 / usdPerToken;                                                      // token / USD
  const buyOut      = usd * tokenPerUsd;                                                    // token received for usd

  const sellDex = sellQ.data[0].routePlan[0]?.swapInfo?.label ?? 'Unknown';

  // 3. USDC → SOL  (always works)
  const buySolQ = await jupQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112', Math.floor(usd * 1e6));
  if (!buySolQ) return [];

  const buyDex  = buySolQ.data[0].routePlan[0]?.swapInfo?.label ?? 'Unknown';
  const solBack = Number(buySolQ.data[0].outAmount) / 1e9; // SOL

  const flashFee = (usd * FLASH_BPS) / 10000; // USD
  const profit   = solBack * usdPerToken - usd - flashFee - (TX_FEE * 3) - JITO_TIP; // USD

  return [{ buyDex, sellDex, profit, buySolRoute: buySolQ.data[0], sellTokenRoute: sellQ.data[0], size: usd }];
}

// ---------- execute ----------
async function exec(mint, buySolRoute, sellTokenRoute, size) {
  try {
    const dec = await getDec(mint);
    const flashFee = (size * FLASH_BPS) / 10000;

    const tx = new Transaction();
    tx.add(await createFlashBorrowInstruction(connection, size, wallet.publicKey));

    const [buyIx, sellIx] = await Promise.all([
      fetch('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: buySolRoute, userPublicKey: wallet.publicKey.toString() })
      }).then(r => r.json()),
      fetch('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: sellTokenRoute, userPublicKey: wallet.publicKey.toString() })
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
  } catch (e) { logger.error(e); return false; }
}

// ---------- telegram ----------
bot.start(ctx => { if (!isAdmin(ctx)) return ctx.reply('❌'); ctx.reply('🚀 Send any SPL-mint'); });
bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌');
  const mint = ctx.message.text.trim();
  try { new PublicKey(mint); } catch { return ctx.reply('❌ Bad mint'); }

  await ctx.reply('🔍 Searching …');
  const routes = await build(mint);
  if (!routes.length) return ctx.reply('❌ No route');
  if (routes[0].profit <= 0) return ctx.reply('📉 No profit after fees');

  const [{ buyDex, sellDex, profit }] = routes;
  ctx.reply(
    `✅ Best 20-USDC round-trip:\n*${buyDex}* ➜ *${sellDex}*  (+${profit.toFixed(4)} USDC)`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Execute', `exec:${mint}`)]
    ]) }
  );
});

bot.action(/exec:(.+)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌');
  const mint = ctx.match[1];
  const [r] = await build(mint);
  if (!r) return ctx.answerCbQuery('❌ route gone');
  ctx.reply('🚀 Executing …');
  const ok = await exec(mint, r.buySolRoute, r.sellTokenRoute, r.size);
  ctx.reply(ok ? '✅ Bundle submitted' : '❌ Exec failed – logs');
  ctx.answerCbQuery();
});

bot.launch();
logger.info('Bot launched');
