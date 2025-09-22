// index.js
// Solana Arbitrage Bot (Mainnet, Flashloan Execution, Admin Restricted)

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fetch from 'node-fetch';
import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import winston from 'winston';
import { createFlashBorrowInstruction, createFlashRepayInstruction } from './solend.js';
import { submitJitoBundle } from './jito.js';
import { isValidMintAddress, isValidDex } from './utils.js';

// === LOGGER ===
const logger = winston.createLogger({
  transports: [new winston.transports.File({ filename: 'bot.log' })]
});

// === ENVIRONMENT VARIABLES ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const DOMAIN = process.env.DOMAIN;
const PORT = process.env.PORT || 10000;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'grpc.mainnet.jito.sh:443';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const JITO_API_KEY = process.env.JITO_API_KEY;

// Mainnet fees
const TX_FEE_PER_SIGNATURE = 0.000005; // SOL per signature
const FLASHLOAN_FEE_BPS = 1; // 0.01% (Solend-like)
const JITO_TIP_FEE = 0.001; // SOL
const SLIPPAGE_BPS = 50; // 0.5%

if (!BOT_TOKEN || !ADMIN_ID || !DOMAIN || !WALLET_PRIVATE_KEY || !JITO_ENDPOINT) {
  logger.error('Missing environment variables');
  process.exit(1);
}

// === SETUP ===
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
const connection = new Connection(SOLANA_RPC, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));

// === HELPER: Check Admin ID ===
function isAdmin(ctx) {
  return ctx.from.id.toString() === ADMIN_ID;
}

// === EXPRESS SERVER ===
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('✅ Solana Arbitrage Bot (Mainnet) is running');
});

app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(`${DOMAIN}/webhook/${BOT_TOKEN}`);
    logger.info('Webhook set successfully');
  } catch (err) {
    logger.error(`Failed to set webhook: ${err.message}`);
  }
});

// === HELPER: Fetch Token Decimals ===
async function getTokenDecimals(mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mint);
    logger.info(`Fetched decimals for mint ${mintAddress}: ${mintInfo.decimals}`);
    return mintInfo.decimals;
  } catch (err) {
    logger.error(`Error fetching token decimals for ${mintAddress}: ${err.message}`);
    return null;
  }
}

// === HELPER: Fetch Jupiter Swap Instructions ===
async function getSwapInstructions(tokenMint, buyDex, sellDex, amount, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const baseMint = 'So11111111111111111111111111111111111111112'; // SOL
      const decimals = await getTokenDecimals(tokenMint);
      if (!decimals) throw new Error('Failed to fetch token decimals');

      // Use smaller amount for RAY (0.1 tokens)
      const amountIn = Math.floor(amount * 10 ** decimals * 0.1); // 0.1 tokens
      const buyUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint}&outputMint=${tokenMint}&amount=${amountIn}&slippageBps=${SLIPPAGE_BPS}`;
      const sellUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=${baseMint}&amount=${amountIn}&slippageBps=${SLIPPAGE_BPS}`;

      logger.info(`Attempt ${attempt}: Fetching swap routes: buy ${buyUrl}, sell ${sellUrl}`);
      const [buyRes, sellRes] = await Promise.all([
        fetch(buyUrl, { headers: { 'Accept': 'application/json' } }),
        fetch(sellUrl, { headers: { 'Accept': 'application/json' } })
      ]);

      const buyText = await buyRes.text();
      const sellText = await sellRes.text();

      if (!buyRes.ok || !sellRes.ok) {
        logger.error(`Jupiter API error (attempt ${attempt}): Buy ${buyRes.status} (${buyText}), Sell ${sellRes.status} (${sellText})`);
        if (buyRes.status === 429 || sellRes.status === 429) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        throw new Error(`HTTP ${buyRes.status || sellRes.status}: ${buyText || sellText}`);
      }

      let buyData, sellData;
      try {
        buyData = JSON.parse(buyText);
        sellData = JSON.parse(sellText);
      } catch (err) {
        logger.error(`JSON parse error (attempt ${attempt}): Buy ${buyText}, Sell ${sellText}`);
        throw new Error(`Invalid JSON response: ${err.message}`);
      }

      if (!buyData.data?.length || !sellData.data?.length) {
        logger.error(`No routes found for mint ${tokenMint}, buyDex ${buyDex}, sellDex ${sellDex}: Buy ${JSON.stringify(buyData)}, Sell ${JSON.stringify(sellData)}`);
        throw new Error(`No routes found: Buy ${buyData.error || 'No data'}, Sell ${sellData.error || 'No data'}`);
      }

      logger.info(`Swap routes fetched for mint ${tokenMint} on attempt ${attempt}`);
      return {
        buyRoute: buyData.data[0],
        sellRoute: sellData.data[0],
        buyOutAmount: buyData.data[0].outAmount / 10 ** decimals,
        sellOutAmount: sellData.data[0].outAmount / 10 ** 9 // SOL has 9 decimals
      };
    } catch (err) {
      logger.error(`Error fetching swap instructions for ${tokenMint} (attempt ${attempt}): ${err.message}`);
      if (attempt === retries) {
        return { error: err.message };
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// === HELPER: Execute Flashloan Trade ===
async function executeFlashloanTrade(tokenMint, buyDex, sellDex, amount) {
  try {
    const decimals = await getTokenDecimals(tokenMint);
    if (!decimals) throw new Error('Invalid token decimals');

    const routes = await getSwapInstructions(tokenMint, buyDex, sellDex, amount);
    if (routes.error) throw new Error(`Swap route error: ${routes.error}`);

    // Calculate fees (amount in tokens)
    const flashloanFee = (amount * 0.1 * FLASHLOAN_FEE_BPS) / 10000; // Adjusted for 0.1 tokens
    const totalFees = TX_FEE_PER_SIGNATURE * 3 + flashloanFee + JITO_TIP_FEE;
    const estimatedProfit = routes.sellOutAmount - routes.buyOutAmount - totalFees;
    logger.info(`Fees: ${totalFees} SOL (Tx: ${TX_FEE_PER_SIGNATURE * 3}, Flashloan: ${flashloanFee}, Jito: ${JITO_TIP_FEE})`);
    logger.info(`Estimated Profit: ${estimatedProfit} SOL`);

    if (estimatedProfit <= 0) {
      logger.warn('Trade not profitable after fees');
      return false;
    }

    const transaction = new Transaction();

    // Add flashloan borrow
    transaction.add(await createFlashBorrowInstruction(connection, amount * 0.1, wallet.publicKey));

    // Add buy swap
    const buySwapRes = await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: routes.buyRoute, userPublicKey: wallet.publicKey.toString() })
    });
    const buySwap = await buySwapRes.json();
    transaction.add(...buySwap.instructions);

    // Add sell swap
    const sellSwapRes = await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: routes.sellRoute, userPublicKey: wallet.publicKey.toString() })
    });
    const sellSwap = await sellSwapRes.json();
    transaction.add(...sellSwap.instructions);

    // Add flashloan repay
    transaction.add(await createFlashRepayInstruction(connection, (amount * 0.1) + flashloanFee, wallet.publicKey));

    // Sign transaction
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    // Submit to Jito
    const serializedTx = transaction.serialize().toString('base64');
    await submitJitoBundle({ transactions: [serializedTx], tip: JITO_TIP_FEE }, JITO_ENDPOINT, JITO_API_KEY);

    logger.info('Trade submitted to Jito bundle');
    return true;
  } catch (err) {
    logger.error(`Trade execution failed: ${err.message}`);
    return false;
  }
}

// === TELEGRAM COMMANDS ===
bot.start(ctx => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ Access denied. This bot is restricted to the admin.');
  }
  ctx.reply(
    '🚀 Welcome to SolanaJitoArbBot (Mainnet), Admin!\n' +
    'Send token mint, buy DEX, and sell DEX in the format:\n' +
    '`token_mint,buy_dex,sell_dex`\n' +
    'E.g., `6MJmeFrTJZ3qcUj8EK6uj2mydHuYG9FRCV29xywbB1Ce,Orca,Raydium`\n' +
    `Fees: ${TX_FEE_PER_SIGNATURE * 3} SOL (tx), ${FLASHLOAN_FEE_BPS / 100}% flashloan, ${JITO_TIP_FEE} SOL (Jito)`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('text', async ctx => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ Access denied. This bot is restricted to the admin.');
  }

  // Sanitize input
  const input = ctx.message.text.trim().split(',').map(item => item.trim());
  if (input.length !== 3) {
    logger.error(`Invalid input format: ${ctx.message.text}`);
    return ctx.reply('❌ Invalid input. Use format: `token_mint,buy_dex,sell_dex`', { parse_mode: 'Markdown' });
  }

  const [tokenMint, buyDex, sellDex] = input;
  logger.info(`Received input: mint=${tokenMint}, buyDex=${buyDex}, sellDex=${sellDex}`);

  if (!isValidMintAddress(tokenMint)) {
    return ctx.reply('❌ Invalid token mint address.', { parse_mode: 'Markdown' });
  }
  if (!isValidDex(buyDex) || !isValidDex(sellDex)) {
    return ctx.reply('❌ Invalid DEX. Supported: Orca, Raydium, Jupiter', { parse_mode: 'Markdown' });
  }

  const routes = await getSwapInstructions(tokenMint, buyDex, sellDex, 1);
  const estimatedProfit = routes.error
    ? null
    : routes.sellOutAmount - routes.buyOutAmount - (TX_FEE_PER_SIGNATURE * 3 + (0.1 * FLASHLOAN_FEE_BPS) / 10000 + JITO_TIP_FEE);

  ctx.reply(
    `🔍 Preparing to execute trade (Mainnet):\n` +
    `Token: \`${tokenMint}\`\n` +
    `Buy on: *${buyDex}*\n` +
    `Sell on: *${sellDex}*\n` +
    `Fees: ${TX_FEE_PER_SIGNATURE * 3} SOL (tx), ${FLASHLOAN_FEE_BPS / 100}% flashloan (0.1 tokens), ${JITO_TIP_FEE} SOL (Jito)\n` +
    (estimatedProfit
      ? `Estimated Profit: ${estimatedProfit.toFixed(6)} SOL`
      : `⚠️ Unable to estimate profit: ${routes.error || 'Unknown error'}`),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Execute Trade', `exec_${tokenMint}_${buyDex}_${sellDex}`)]
      ])
    }
  );
});

// === TELEGRAM CALLBACKS ===
bot.on('callback_query', async ctx => {
  if (!isAdmin(ctx)) {
    ctx.answerCbQuery('❌ Access denied. This bot is restricted to the admin.');
    return ctx.reply('❌ Access denied. This bot is restricted to the admin.');
  }

  const data = ctx.callbackQuery.data;
  if (data.startsWith('exec_')) {
    const [_, tokenMint, buyDex, sellDex] = data.split('_');
    logger.info(`Executing trade: mint=${tokenMint}, buyDex=${buyDex}, sellDex=${sellDex}`);
    ctx.reply(`🚀 Executing flashloan trade (Mainnet)...\nToken: ${tokenMint}\nBuy: ${buyDex}\nSell: ${sellDex}`);

    const success = await executeFlashloanTrade(tokenMint, buyDex, sellDex, 1);
    if (success) {
      ctx.reply('✅ Trade executed successfully on Mainnet!');
    } else {
      ctx.reply('❌ Trade execution failed. Check logs for details.');
    }
  }

  ctx.answerCbQuery();
});

// === START BOT ===
bot.launch();
logger.info('Bot launched on Mainnet');
