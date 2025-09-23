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

// ⚠️ You are using a public RPC hosted by Triton One (fra113.nodes.rpcpool.com).
// For production arbitrage bots, use a private, low-latency RPC:
// → Helius (https://www.helius.dev) — Free tier available
// → QuickNode (https://www.quicknode.com)
const SOLANA_RPC    = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
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

// Helper: Fetch with timeout
async function fetchWithTimeout(resource, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal
  });
  clearTimeout(id);
  return response;
}

async function jupQuote(inputMint, outputMint, amount) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE}&onlyDirectRoutes=false`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      logger.warn(`Jupiter quote non-200: ${r.status}`);
      return null;
    }
    const j = await r.json();
    return j.data?.length ? j : null;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      logger.warn(`Jupiter quote timeout: ${inputMint} → ${outputMint}`);
    } else {
      logger.error(`Jupiter quote error: ${e.message}`);
    }
    return null;
  }
}

// Helper: Get SOL/USDC price to convert fees
async function getSolPrice() {
  try {
    const q = await jupQuote('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1e9);
    if (q && q.data?.[0]?.outAmount) {
      return Number(q.data[0].outAmount) / 1e6;
    }
  } catch (e) {
    logger.warn(`Failed to get SOL price: ${e.message}`);
  }
  return 150; // Fallback
}

// ---------- build ----------
async function build(mint, usd = SIZE_USD) {
  const dec = await getDec(mint);
  if (!dec) {
    logger.warn(`No decimals for mint: ${mint}`);
    return [];
  }

  // 1. USDC → TOKEN
  const buyTokenQ = await jupQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', mint, Math.floor(usd * 1e6));
  if (!buyTokenQ) {
    logger.warn(`No buy route for ${mint}`);
    return [];
  }

  const buyDex = buyTokenQ.data[0].routePlan[0]?.swapInfo?.label ?? 'Unknown';
  const tokenOut = Number(buyTokenQ.data[0].outAmount) / (10 ** dec);

  // 2. TOKEN → USDC
  const sellQ = await jupQuote(mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', Math.floor(tokenOut * 10 ** dec));
  if (!sellQ) {
    logger.warn(`No sell route for ${mint}`);
    return [];
  }

  const sellDex = sellQ.data[0].routePlan[0]?.swapInfo?.label ?? 'Unknown';
  const usdcBack = Number(sellQ.data[0].outAmount) / 1e6;

  // 3. Profit calc
  const flashFee = (usd * FLASH_BPS) / 10000;
  const solPrice = await getSolPrice();
  const jitoTipUsd = JITO_TIP * solPrice;
  const txFeesUsd = (TX_FEE * 3) * solPrice;
  const totalFees = flashFee + txFeesUsd + jitoTipUsd;
  const profit = usdcBack - usd - totalFees;

  logger.info(`Route: ${buyDex} → ${sellDex} | Profit: ${profit.toFixed(4)} USDC`);

  return [{
    buyDex,
    sellDex,
    profit,
    buyTokenRoute: buyTokenQ.data[0],
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

    const timeoutMs = 8000;

    const [buyIxRes, sellIxRes] = await Promise.all([
      fetchWithTimeout('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: buyTokenRoute, userPublicKey: wallet.publicKey.toString() })
      }, timeoutMs),
      fetchWithTimeout('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: sellTokenRoute, userPublicKey: wallet.publicKey.toString() })
      }, timeoutMs)
    ]);

    const buyIx = await buyIxRes.json();
    const sellIx = await sellIxRes.json();

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
  ctx.reply('🚀 Send any SPL-mint (e.g., PUMP, WIF)');
});

bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('❌');
  const mint = ctx.message.text.trim();
  try { new PublicKey(mint); } catch { return ctx.reply('❌ Bad mint'); }

  // Send initial message and capture its ID for safe editing
  const initialMsg = await ctx.reply('🔍 Searching… (0/3)');
  const chatId = initialMsg.chat.id;
  const messageId = initialMsg.message_id;

  // Helper to safely update status
  const updateStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text);
    } catch (e) {
      logger.warn(`Failed to update message: ${e.message}`);
      // Optional: send new message if edit fails
      // await ctx.reply(text);
    }
  };

  try {
    await updateStatus('🔍 Searching… (1/3) Getting token decimals');
    const dec = await getDec(mint);
    if (!dec) return updateStatus('❌ Token not found or no decimals');

    await updateStatus('🔍 Searching… (2/3) Quoting USDC → Token');
    const buyTokenQ = await jupQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', mint, Math.floor(SIZE_USD * 1e6));
    if (!buyTokenQ) return updateStatus('❌ No route: USDC → Token');

    const tokenOut = Number(buyTokenQ.data[0].outAmount) / (10 ** dec);

    await updateStatus('🔍 Searching… (3/3) Quoting Token → USDC');
    const sellQ = await jupQuote(mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', Math.floor(tokenOut * 10 ** dec));
    if (!sellQ) return updateStatus('❌ No route: Token → USDC');

    const routes = await build(mint, SIZE_USD);
    if (!routes.length || routes[0].profit <= 0) {
      return updateStatus(`📉 No profit after fees (${routes[0]?.profit?.toFixed(4) || 0} USDC)`);
    }

    const [{ buyDex, sellDex, profit }] = routes;
    await ctx.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      `✅ Best ${SIZE_USD}-USDC round-trip:\n*${buyDex}* ➜ *${sellDex}*  (+${profit.toFixed(4)} USDC)`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Execute', callback_data: `exec:${mint}` }]
          ]
        }
      }
    );
  } catch (e) {
    logger.error(e);
    await updateStatus('❌ Search failed – check server logs');
  }
});

bot.action(/exec:(.+)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Not authorized');

  // ✅ Always acknowledge button press immediately
  await ctx.answerCbQuery('⏳ Executing...');

  const mint = ctx.match[1];
  await ctx.reply('⏳ Building transaction…');

  try {
    const [r] = await build(mint);
    if (!r) return ctx.reply('❌ Route expired or invalid');

    const ok = await exec(mint, r.buyTokenRoute, r.sellTokenRoute, r.size);
    await ctx.reply(ok ? '✅ Bundle submitted to Jito' : '❌ Execution failed – check logs');
  } catch (e) {
    logger.error(e);
    await ctx.reply('❌ Unexpected error during execution');
  }
});

bot.launch();
logger.info('✅ Bot launched – send SPL mint to start');
