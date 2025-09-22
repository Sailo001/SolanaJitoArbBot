// index.js (Updated with Modular Imports)
// Solana Arbitrage Bot (Flashloan Execution with MEV Protection, Admin Restricted)

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fetch from 'node-fetch';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import { createFlashBorrowInstruction, createFlashRepayInstruction } from './solend.js';
import { submitJitoBundle } from './jito.js';
import { isValidMintAddress, isValidDex } from './utils.js';

// === ENVIRONMENT VARIABLES ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const DOMAIN = process.env.DOMAIN;
const PORT = process.env.PORT || 10000;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT;
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!BOT_TOKEN || !ADMIN_ID || !DOMAIN || !JITO_ENDPOINT || !WALLET_PRIVATE_KEY) {
  console.error("❌ Missing environment variables.");
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
  res.send('✅ Solana Arbitrage Bot is running');
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(`${DOMAIN}/webhook/${BOT_TOKEN}`);
    console.log("✅ Webhook set successfully");
  } catch (err) {
    console.error("❌ Failed to set webhook:", err.message);
  }
});

// === HELPER: Fetch Token Decimals ===
async function getTokenDecimals(mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mint);
    return mintInfo.decimals;
  } catch (err) {
    console.error("❌ Error fetching token decimals:", err.message);
    return null;
  }
}

// === HELPER: Fetch Jupiter Swap Instructions ===
async function getSwapInstructions(tokenMint, buyDex, sellDex, amount) {
  try {
    const baseMint = "So11111111111111111111111111111111111111112"; // SOL
    const amountIn = amount * 1e9; // SOL has 9 decimals
    const buyUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint}&outputMint=${tokenMint}&amount=${amountIn}&slippageBps=50&onlyDirectRoutes=true&dexes=${buyDex}`;
    const sellUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=${baseMint}&amount=${amountIn}&slippageBps=50&onlyDirectRoutes=true&dexes=${sellDex}`;

    const [buyRes, sellRes] = await Promise.all([fetch(buyUrl), fetch(sellUrl)]);
    if (!buyRes.ok || !sellRes.ok) throw new Error(`HTTP ${buyRes.status || sellRes.status}`);
    
    const [buyData, sellData] = await Promise.all([buyRes.json(), sellRes.json()]);
    if (!buyData.data?.length || !sellData.data?.length) throw new Error("No routes found");

    return { buyRoute: buyData.data[0], sellRoute: sellData.data[0] };
  } catch (err) {
    console.error("❌ Error fetching swap instructions:", err.message);
    return null;
  }
}

// === HELPER: Execute Flashloan Trade ===
async function executeFlashloanTrade(tokenMint, buyDex, sellDex, amount) {
  try {
    const decimals = await getTokenDecimals(tokenMint);
    if (!decimals) throw new Error("Invalid token decimals");

    const routes = await getSwapInstructions(tokenMint, buyDex, sellDex, amount);
    if (!routes) throw new Error("Failed to fetch swap routes");

    const transaction = new Transaction();
    
    // Add flashloan borrow
    transaction.add(await createFlashBorrowInstruction(connection, amount, wallet.publicKey));

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
    transaction.add(await createFlashRepayInstruction(connection, amount, wallet.publicKey));

    // Sign transaction
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    // Submit to Jito
    const serializedTx = transaction.serialize().toString('base64');
    await submitJitoBundle({ transactions: [serializedTx] }, JITO_ENDPOINT);

    console.log("✅ Trade submitted to Jito bundle");
    return true;
  } catch (err) {
    console.error("❌ Trade execution failed:", err.message);
    return false;
  }
}

// === TELEGRAM COMMANDS ===
bot.start(ctx => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ Access denied. This bot is restricted to the admin.");
  }
  ctx.reply(
    "🚀 Welcome to SolanaJitoArbBot, Admin!\n" +
    "Send token mint, buy DEX, and sell DEX in the format:\n" +
    "`token_mint,buy_dex,sell_dex`\n" +
    "E.g., `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Orca,Raydium`",
    { parse_mode: "Markdown" }
  );
});

bot.on("text", async ctx => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ Access denied. This bot is restricted to the admin.");
  }

  const input = ctx.message.text.trim().split(",");
  if (input.length !== 3) {
    return ctx.reply("❌ Invalid input. Use format: `token_mint,buy_dex,sell_dex`", { parse_mode: "Markdown" });
  }

  const [tokenMint, buyDex, sellDex] = input;
  if (!isValidMintAddress(tokenMint)) {
    return ctx.reply("❌ Invalid token mint address.", { parse_mode: "Markdown" });
  }
  if (!isValidDex(buyDex) || !isValidDex(sellDex)) {
    return ctx.reply("❌ Invalid DEX. Supported: Orca, Raydium, Jupiter", { parse_mode: "Markdown" });
  }

  ctx.reply(
    `🔍 Preparing to execute trade:\n` +
    `Token: \`${tokenMint}\`\n` +
    `Buy on: *${buyDex}*\n` +
    `Sell on: *${sellDex}*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Execute Trade", `exec_${tokenMint}_${buyDex}_${sellDex}`)]
      ])
    }
  );
});

// === TELEGRAM CALLBACKS ===
bot.on("callback_query", async ctx => {
  if (!isAdmin(ctx)) {
    ctx.answerCbQuery("❌ Access denied. This bot is restricted to the admin.");
    return ctx.reply("❌ Access denied. This bot is restricted to the admin.");
  }

  const data = ctx.callbackQuery.data;
  if (data.startsWith("exec_")) {
    const [_, tokenMint, buyDex, sellDex] = data.split("_");
    ctx.reply(`🚀 Executing flashloan trade...\nToken: ${tokenMint}\nBuy: ${buyDex}\nSell: ${sellDex}`);

    const success = await executeFlashloanTrade(tokenMint, buyDex, sellDex, 1); // 1 SOL
    if (success) {
      ctx.reply("✅ Trade executed successfully via Jito bundle!");
    } else {
      ctx.reply("❌ Trade execution failed. Check logs for details.");
    }
  }

  ctx.answerCbQuery();
});

// === START BOT ===
bot.launch();
console.log("✅ Bot launched");
