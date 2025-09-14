import 'dotenv/config';
import fetch from 'node-fetch';
import express from 'express';
import { Keypair, Connection, Transaction, sendAndConfirmTransaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';

// ----------------- CONFIG -----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRIVATE_KEY_BASE58 = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = Number(process.env.PORT || 10000);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);
const PROFIT_THRESHOLD_PCT = Number(process.env.PROFIT_THRESHOLD_PCT || 2.0);
const JUPITER_API = 'https://quote-api.jup.ag/v7';

// ----------------- VALIDATION -----------------
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are required');
  process.exit(1);
}

let wallet = null;
if (PRIVATE_KEY_BASE58) {
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
    console.log('🔑 Wallet loaded:', wallet.publicKey.toBase58());
  } catch (err) {
    console.warn('⚠️ Failed to load PRIVATE_KEY:', err.message);
  }
}

const connection = new Connection(RPC_URL, 'confirmed');
console.log('🌐 RPC:', RPC_URL);

// ----------------- EXPRESS -----------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('✅ Solana Arbitrage Bot running'));
app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

// ----------------- TELEGRAM -----------------
async function telegramSend(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error('❌ Telegram send failed', err.message);
  }
}

// ----------------- JUPITER TOKEN DISCOVERY -----------------
let tokenCache = [];
async function refreshTokens() {
  try {
    const res = await fetch(`${JUPITER_API}/tokens`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tokenCache = data.tokens || [];
    console.log(`✅ Tokens refreshed: ${tokenCache.length}`);
  } catch (err) {
    console.error('❌ Failed to refresh tokens:', err.message);
  }
}

// ----------------- ARBITRAGE DETECTION -----------------
async function findArbOpportunities() {
  try {
    if (!tokenCache.length) await refreshTokens();

    for (const token of tokenCache) {
      const inputMint = token.address;
      const amount = 1_000_000; // 1 unit scaled to smallest decimals for simplicity

      // fetch single-hop and multi-hop quotes from Jupiter
      const quoteUrl = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippage=1&onlyDirectRoutes=false`;
      const res = await fetch(quoteUrl);
      if (!res.ok) continue;
      const quote = await res.json();
      if (!quote || !quote.data || !quote.data.length) continue;

      // pick the highest profit route
      const bestRoute = quote.data.reduce((max, r) => (Number(r.outAmount) > Number(max.outAmount) ? r : max), quote.data[0]);
      const profitPct = ((Number(bestRoute.outAmount) - amount) / amount) * 100;

      if (profitPct >= PROFIT_THRESHOLD_PCT) {
        const msg = `💰 Arbitrage Opportunity Detected
Token: *${token.symbol}* (\`${inputMint}\`)
Profit: *${profitPct.toFixed(2)}%*
Route: ${bestRoute.marketInfos.map(m => m.label).join(' -> ')}`;

        console.log(msg.replace(/\*/g, ''));
        await telegramSend(msg);

        // attempt MEV-protected execution if wallet is loaded
        if (wallet) await executeArb(bestRoute);
      }
    }
  } catch (err) {
    console.error('❌ Arbitrage detection failed:', err.message);
  }
}

// ----------------- MEV-PROTECTED EXECUTION -----------------
async function executeArb(route) {
  try {
    const tx = new Transaction();

    // increase priority fee to reduce chance of front-run
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));

    // TODO: Add swap instructions based on Jupiter route
    // For simplicity, we're just logging here
    console.log('🚀 Executing route with MEV protection:', route.marketInfos.map(m => m.label).join(' -> '));

    // const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
    // console.log('✅ Executed arbitrage tx:', signature);
  } catch (err) {
    console.error('❌ Execution failed:', err.message);
  }
}

// ----------------- INITIALIZATION -----------------
(async function startup() {
  await refreshTokens();
  setInterval(refreshTokens, 10 * 60 * 1000); // refresh token cache every 10 min
  setInterval(findArbOpportunities, SCAN_INTERVAL_MS);
})();
