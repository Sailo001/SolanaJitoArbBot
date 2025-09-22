// index.js  –  Solana Arbitrage Bot (main-net, flash-loan, admin-restricted)
//  –  drop a token-mint → bot finds the best routes automatically
//  –  old “mint,buyDex,sellDex” still works if you need it

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fetch from 'node-fetch';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import winston from 'winston';
import { createFlashBorrowInstruction, createFlashRepayInstruction } from './solend.js';
import { submitJitoBundle } from './jito.js';
import { isValidMintAddress, isValidDex } from './utils.js';

// -----------------  LOGGER  -----------------
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'bot.log' }),
    new winston.transports.Console()
  ]
});

// -----------------  ENV  -----------------
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID     = process.env.TELEGRAM_ADMIN_ID;
const DOMAIN       = process.env.DOMAIN;
const PORT         = process.env.PORT || 10000;
const SOLANA_RPC   = process.env.SOLANA_RPC   || 'https://api.mainnet-beta.solana.com';
const JITO_ENDPOINT= process.env.JITO_ENDPOINT|| 'grpc.mainnet.jito.sh:443';
const WALLET_PK    = process.env.WALLET_PRIVATE_KEY;
const JITO_API_KEY = process.env.JITO_API_KEY;

// main-net fees
const TX_FEE_PER_SIGNATURE = 0.000005;   // SOL
const FLASHLOAN_FEE_BPS    = 1;          // 0.01 %
const JITO_TIP_FEE         = 0.001;      // SOL
const SLIPPAGE_BPS         = 50;         // 0.5 %

if (!BOT_TOKEN || !ADMIN_ID || !DOMAIN || !WALLET_PK) {
  logger.error('Missing env vars'); process.exit(1);
}

// -----------------  SETUP  -----------------
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
const connection = new Connection(SOLANA_RPC, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PK));

app.get('/', (_, res) => res.send('✅ Solana Arbitrage Bot (mainnet) is running'));
app.listen(PORT, async () => {
  logger.info(`Server on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(`${DOMAIN}/webhook/${BOT_TOKEN}`);
    logger.info('Webhook set');
  } catch (e) { logger.error(e); }
});

// --------------  ADMIN CHECK  --------------
const isAdmin = ctx => ctx.from.id.toString() === ADMIN_ID;

// --------------  TOKEN DECIMALS  --------------
async function getTokenDecimals(mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const info = await getMint(connection, mint);
    return info.decimals;
  } catch (e) {
    logger.error(`decimals fetch ${mintAddress}: ${e.message}`);
    return null;
  }
}

// --------------  QUOTE HELPERS  --------------
async function jupQuote(inputMint, outputMint, amountLamports, retries = 3) {
  // TRIMMED + SPACE-FREE URLs
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.trim()}&outputMint=${outputMint.trim()}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}&onlyDirectRoutes=false`;
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (r.ok && j.data?.length) return j;
      if (r.status === 429) await new Promise(res => setTimeout(res, i * 400));
    } catch (e) { logger.warn(`quote attempt ${i} ${e.message}`); }
  }
  return null;
}

// --------------  BUILD ROUTES  (1 SOL) --------------
async function buildBestRoutes(tokenMint, amountSol = 1) {
  const decimals = await getTokenDecimals(tokenMint);
  if (!decimals) return [];

  const lamports    = Math.floor(amountSol * 10 ** decimals); // token lamports
  const solLamports = Math.floor(amountSol * 1e9);            // 1 SOL

  const [buyQ, sellQ] = await Promise.all([
    jupQuote('So11111111111111111111111111111111111111112', tokenMint, solLamports),
    jupQuote(tokenMint, 'So11111111111111111111111111111111111111112', lamports)
  ]);
  if (!buyQ || !sellQ) return [];

  const combos = [];
  for (const b of buyQ.data) {
    for (const s of sellQ.data) {
      const buyDex  = b.routePlan[0]?.swapInfo?.label ?? 'Unknown';
      const sellDex = s.routePlan[0]?.swapInfo?.label ?? 'Unknown';

      const buyOut  = Number(b.outAmount)  / 10 ** decimals;
      const sellOut = Number(s.outAmount)  / 1e9;          // back to SOL

      const flashFeeSol = (amountSol * FLASHLOAN_FEE_BPS) / 10000;
      const totalFeesSol = TX_FEE_PER_SIGNATURE * 3 + JITO_TIP_FEE + flashFeeSol;
      const profit = sellOut - buyOut - totalFeesSol;

      combos.push({ buyDex, sellDex, profit, buyRoute: b, sellRoute: s });
    }
  }
  combos.sort((a, b) => b.profit - a.profit);
  return combos;
}

// --------------  EXECUTE  --------------
async function executeFlashloanTrade(tokenMint, buyDex, sellDex, amountSol = 1) {
  try {
    const decimals = await getTokenDecimals(tokenMint);
    if (!decimals) throw new Error('bad decimals');

    const lamports    = Math.floor(amountSol * 10 ** decimals);
    const solLamports = Math.floor(amountSol * 1e9);

    const [buyQ, sellQ] = await Promise.all([
      jupQuote('So11111111111111111111111111111111111111112', tokenMint, solLamports),
      jupQuote(tokenMint, 'So11111111111111111111111111111111111111112', lamports)
    ]);
    if (!buyQ || !sellQ) throw new Error('no route');

    const buyRoute  = buyQ.data.find(r => (r.routePlan[0]?.swapInfo?.label ?? '') === buyDex);
    const sellRoute = sellQ.data.find(r => (r.routePlan[0]?.swapInfo?.label ?? '') === sellDex);
    if (!buyRoute || !sellRoute) throw new Error('dex not in route');

    const flashFee = (amountSol * FLASHLOAN_FEE_BPS) / 10000;
    const estProfit = Number(sellRoute.outAmount) / 1e9
                    - Number(buyRoute.outAmount) / 10 ** decimals
                    - (TX_FEE_PER_SIGNATURE * 3 + flashFee + JITO_TIP_FEE);
    if (estProfit <= 0) return false;

    const tx = new Transaction();
    tx.add(await createFlashBorrowInstruction(connection, amountSol, wallet.publicKey));

    // SPACE-FREE URLs
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
    if (buyIx.error || sellIx.error) throw new Error('swap-ix error');
    tx.add(...buyIx.instructions, ...sellIx.instructions);
    tx.add(await createFlashRepayInstruction(connection, amountSol + flashFee, wallet.publicKey));

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const ser = tx.serialize().toString('base64');
    await submitJitoBundle({ transactions: [ser], tip: JITO_TIP_FEE }, JITO_ENDPOINT, JITO_API_KEY);
    logger.info('bundle submitted'); return true;
  } catch (e) { logger.error(`exec fail: ${e.message}`); return false; }
}

// --------------  TELEGRAM  --------------
bot.start(ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌ Access denied.');
  ctx.reply(
    '🚀 Solana Arbitrage Bot (mainnet)\n' +
    'Send a token-mint and I find the best routes automatically.\n' +
    '(Old format: `mint,buyDex,sellDex` still works.)',
    { parse_mode: 'Markdown' }
  );
});

bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌ Access denied.');

  const txt = ctx.message.text.trim();

  // ---------- old manual format ----------
  if (txt.includes(',')) {
    const [mint, buyDex, sellDex] = txt.split(',').map(x => x.trim());
    if (!isValidMintAddress(mint) || !isValidDex(buyDex) || !isValidDex(sellDex)) {
      return ctx.reply('❌ Invalid mint or dex.');
    }
    const routes = await buildBestRoutes(mint);
    const found = routes.find(r => r.buyDex === buyDex && r.sellDex === sellDex);
    if (!found) return ctx.reply('❌ No route for those dexes.');
    const est = found.profit;
    return ctx.reply(
      `🔍 Manual route:\nBuy *${buyDex}*  ➜  Sell *${sellDex}*\nEst. profit: ${est.toFixed(6)} SOL`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Execute', `exec_${mint}_${buyDex}_${sellDex}`)]
      ]) }
    );
  }

  // ---------- new automatic flow ----------
  if (!isValidMintAddress(txt)) return ctx.reply('❌ Invalid mint address.');
  const mint = txt;
  await ctx.reply('🔍 Searching best routes …');
  const routes = await buildBestRoutes(mint);
  if (!routes.length) return ctx.reply('❌ No liquid routes found.');
  const top = routes.slice(0, 3);
  if (top[0].profit <= 0) return ctx.reply('📉 No profitable route after fees.');

  let m = `✅ Top routes for *${mint.slice(0, 8)}…* :\n`;
  const kb = [];
  top.forEach((r, i) => {
    m += `\n${i+1}. *${r.buyDex}*  ➜  *${r.sellDex}*  (+${r.profit.toFixed(6)} SOL)`;
    kb.push([Markup.button.callback(`${i+1}. ${r.buyDex}→${r.sellDex}`, `exec_${mint}_${r.buyDex}_${r.sellDex}`)]);
  });
  return ctx.reply(m, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.on('callback_query', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery('❌'); return; }
  const data = ctx.callbackQuery.data;
  if (data.startsWith('exec_')) {
    const [_, mint, buyDex, sellDex] = data.split('_');
    ctx.reply(`🚀 Executing …\n*${buyDex}* ➜ *${sellDex}*`, { parse_mode: 'Markdown' });
    const ok = await executeFlashloanTrade(mint, buyDex, sellDex);
    ctx.reply(ok ? '✅ Bundle submitted.' : '❌ Execution failed – check logs.');
  }
  ctx.answerCbQuery();
});

bot.launch();
logger.info('Bot launched');
