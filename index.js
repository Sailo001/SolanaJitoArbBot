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
const SOLANA_RPC    = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com'; // ✅ Removed trailing space
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'grpc.mainnet.jito.sh:443';
const WALLET_PK     = process.env.WALLET_PRIVATE_KEY;
const JITO_API_KEY  = process.env.JITO_API_KEY;

const SIZE_USD      = 20;          // test size
const TX_FEE        = 0.000005;    // per sig (in SOL)
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
  } catch (e) {
    logger.error(`Jupiter quote failed: ${e.message}`);
    return null;
  }
}

// Helper: Get SOL/USDC price to convert JITO_TIP (SOL) into USD for profit calc
async function getSolPrice() {
  try {
    const q = await jupQuote('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1e9);
    if (q && q.data?.[0]?.outAmount) {
      return Number(q.data[0].outAmount) / 1e6;
    }
  } catch (e) {
    logger.warn(`Failed to get SOL price: ${e.message}`);
  }
  return 150; // Fallback price in USD
}

// ---------- build ----------
async function build(mint, usd = SIZE_USD) {
  const dec = await getDec(mint);
  if (!dec) {
    logger.warn(`No decimals for mint: ${mint}`);
    return [];
  }

  // 1. USDC → TOKEN (buy leg)
  const buyTokenQ = await jupQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', mint, Math.floor(usd * 1e6));
  if (!buyTokenQ) {
    logger.warn(`No buy route for ${mint}`);
    return [];
  }

  const buyDex = buyTokenQ.data[0].routePlan[0]?.swapInfo?.label ?? 'Unknown';
  const tokenOut = Number(buyTokenQ.data[0].outAmount) / (10 ** dec); // tokens received

  // 2. TOKEN → USDC (sell leg)
  const sellQ = await jupQuote(mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', Math.floor(tokenOut * 10 ** dec));
  if (!sellQ) {
    logger.warn(`No sell route for ${mint}`);
    return [];
  }

  const sellDex = sellQ.data[0].routePlan[0]?.swapInfo?.label ?? 'Unknown';
  const usdcBack = Number(sellQ.data[0].outAmount) / 1e6; // USDC received

  // 3. Calculate Profit
  const flashFee = (usd * FLASH_BPS) / 10000; // USD
  const solPrice = await getSolPrice();
  const jitoTipUsd = JITO_TIP * solPrice;
  const totalFees = flashFee + (TX_FEE * 3 * solPrice) + jitoTipUsd; // Convert TX fees (SOL) to USD
  const profit = usdcBack - usd - totalFees;

  logger.info(`Route: ${buyDex} → ${sellDex} | Profit: ${profit.toFixed(4)} USDC`);

  return [{
    buyDex,
    sellDex,
    profit,
    buyTokenRoute: buyTokenQ.data[0],  // ✅ Now passing correct buy route
    sellTokenRoute: sellQ.data[0],
    size: usd
  }];
}

// ---------- execute ----------
async function exec(mint, buyTokenRoute, sellTokenRoute, size) {
  try {
    const dec = await getDec(mint);
    const flashFee = (size * FLASH_BPS) / 10000;

    const tx = new Transaction();
    tx.add(await createFlashBorrowInstruction(connection, size, wallet.publicKey));

    // Fetch swap instructions for both legs
    const [buyIx, sellIx] = await Promise.all([
      fetch('https://quote-api.jup.ag/v6/swap-instructions', { // ✅ Removed space
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: buyTokenRoute, userPublicKey: wallet.publicKey.toString() })
      }).then(r => r.json()),
      fetch('https://quote-api.jup.ag/v6/swap-instructions', { // ✅ Removed space
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: sellTokenRoute, userPublicKey: wallet.publicKey.toString() })
      }).then(r => r.json())
    ]);

    if (buyIx.error || sellIx.error) {
      throw new Error(`Swap instruction error: ${buyIx.error || sellIx.error}`);
    }

    tx.add(...buyIx.instructions, ...sellIx.instructions);
    tx.add(await createFlashRepayInstruction(connection, size + flashFee, wallet.publicKey));

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const ser = tx.serialize().toString('base64');
    await submitJitoBundle({ transactions: [ser], tip: JITO_TIP }, JITO_ENDPOINT, JITO_API_KEY);
    logger.info('✅ Bundle submitted successfully');
    return true;
  } catch (e) {
    logger.error(`Execution failed: ${e.message}`, e);
    return false;
  }
}

// ---------- telegram ----------
bot.start(ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌');
  ctx.reply('🚀 Send any SPL-mint');
});

bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌');
  const mint = ctx.message.text.trim();
  try { new PublicKey(mint); } catch { return ctx.reply('❌ Bad mint'); }

  await ctx.reply('🔍 Searching …');
  const routes = await build(mint);
  if (!routes.length) return ctx.reply('❌ No route found');
  if (routes[0].profit <= 0) return ctx.reply(`📉 No profit after fees (${routes[0].profit.toFixed(4)} USDC)`);

  const [{ buyDex, sellDex, profit }] = routes;
  ctx.reply(
    `✅ Best ${SIZE_USD}-USDC round-trip:\n*${buyDex}* ➜ *${sellDex}*  (+${profit.toFixed(4)} USDC)`,
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

  await ctx.reply('🚀 Executing …');
  const ok = await exec(mint, r.buyTokenRoute, r.sellTokenRoute, r.size); // ✅ Using correct routes
  await ctx.reply(ok ? '✅ Bundle submitted' : '❌ Exec failed – check logs');
  ctx.answerCbQuery();
});

bot.launch();
logger.info('Bot launched');
