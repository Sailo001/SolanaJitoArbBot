// index.js
import 'dotenv/config';
import { createServer } from 'http';
import { Telegraf } from 'telegraf';
import { Connection, Keypair, Transaction, MessageV0, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';

// === Basic config & envs ===
const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';

const ENABLE_SCAN = process.env.ENABLE_SCAN === 'true';
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000); // 30s default
const SAMPLE_AMOUNT_UI = Number(process.env.SAMPLE_AMOUNT_UI || 1); // UI units for route probing (per-token)
const SAMPLE_AMOUNT_USD = Number(process.env.SAMPLE_AMOUNT_USD || 100); // USD nominal amount when STABLE_MINT provided
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 7);
const MAX_TRADE_SIZE_USD = Number(process.env.MAX_TRADE_SIZE_USD || 500);
const ENABLE_EXECUTE = process.env.ENABLE_EXECUTE === 'true'; // must be explicitly true to attempt real trades
const WATCH_TOKENS = (process.env.WATCH_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const STABLE_MINT = process.env.STABLE_MINT || ''; // set to USDC mint (optional, for USD estimates)

// Jupiter endpoints
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP = 'https://quote-api.jup.ag/v6/swap';
const JUPITER_TOKENS = 'https://tokens.jup.ag/api/tokens';

// Raydium public liquidity list
const RAYDIUM_LIQUIDITY_JSON = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

// === TELEGRAM BOT SETUP ===
const bot = new Telegraf(TELEGRAM_TOKEN);

// Telegram notifier helper
async function telegramSend(text) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error('telegramSend error', err?.message || err);
  }
}

// === RPC selection: MEV_RELAY fallback to SOLANA_RPC ===
let relay;
if (process.env.MEV_RELAY) {
  relay = process.env.MEV_RELAY;
  console.log(`✅ Using MEV relay endpoint: ${relay}`);
} else if (process.env.SOLANA_RPC) {
  relay = process.env.SOLANA_RPC;
  console.log(`⚠️  MEV_RELAY not set, falling back to SOLANA_RPC: ${relay}`);
} else {
  console.error('❌ No RPC endpoint found. Please set MEV_RELAY or SOLANA_RPC in your .env file.');
  process.exit(1);
}
const connection = new Connection(relay, 'confirmed');

// === WALLET ===
if (!process.env.PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY not set in .env (base58)');
  process.exit(1);
}
const secretKey = bs58.decode(process.env.PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);
console.log(`🔑 Wallet loaded: ${wallet.publicKey.toBase58()}`);

// === Simple Telegram commands ===
bot.start((ctx) => ctx.reply('🚀 Solana Arbitrage Bot started!'));
bot.command('balance', async (ctx) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    ctx.reply(`💰 Balance: ${balance / 1e9} SOL`);
  } catch (err) {
    console.error('Balance check failed', err);
    ctx.reply('❌ Failed to fetch balance');
  }
});
bot.command('rpc', (ctx) => ctx.reply(`🌐 Active RPC endpoint: ${relay}`));

// === Utilities: fetch JSON ===
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${url} -> ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

// === Token decimals cache from Jupiter tokens list ===
let TOKEN_DECIMALS = {};
async function refreshTokenDecimals() {
  try {
    const data = await fetchJson(JUPITER_TOKENS);
    for (const t of data) {
      if (t.address && typeof t.decimals === 'number') TOKEN_DECIMALS[t.address] = t.decimals;
    }
    console.log('Token decimals loaded:', Object.keys(TOKEN_DECIMALS).length);
  } catch (e) {
    console.warn('Failed to refresh token decimals:', e?.message || e);
  }
}

// === Raydium pools cache ===
let RAYDIUM_POOLS = null;
async function refreshRaydiumPools() {
  try {
    const data = await fetchJson(RAYDIUM_LIQUIDITY_JSON);
    const pools = (data.official || data).concat(data.unOfficial || []);
    const map = new Map();
    for (const p of pools) {
      const a = p.tokenMintA || p.baseMint;
      const b = p.tokenMintB || p.quoteMint;
      if (!a || !b) continue;
      map.set(`${a}|${b}`, p);
      map.set(`${b}|${a}`, p);
    }
    RAYDIUM_POOLS = map;
    console.log('Raydium pools loaded:', RAYDIUM_POOLS.size);
  } catch (e) {
    console.warn('Failed to refresh Raydium pools:', e?.message || e);
    RAYDIUM_POOLS = null;
  }
}

// === Price sources ===

// Jupiter-derived price: returns { price, routeObj } where price = output per input (normalized)
async function jupiterDerivedPrice(inputMint, outputMint, amountUi = 1) {
  try {
    const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`;
    const data = await fetchJson(url);
    if (!data || !data.data || data.data.length === 0) return null;
    const route = data.data[0];
    // Jupiter returns inAmount/outAmount as smallest units (strings)
    const inAmount = BigInt(route.inAmount || '0');
    const outAmount = BigInt(route.outAmount || '0');
    const decIn = TOKEN_DECIMALS[inputMint] ?? 0;
    const decOut = TOKEN_DECIMALS[outputMint] ?? 0;
    if (inAmount === 0n) return null;
    // price = (out / 10^decOut) / (in / 10^decIn) = (Number(out) * 10^decIn) / (Number(in) * 10^decOut)
    const price = (Number(outAmount) * (10 ** decIn)) / (Number(inAmount) * (10 ** decOut));
    return { price, route };
  } catch (e) {
    return null;
  }
}

// Raydium pool price (if pool available): price = how many B per 1 A
function raydiumPoolPrice(pool, aMint, bMint) {
  try {
    const ra = pool.reserveA ?? pool.baseAmount ?? pool.amountA;
    const rb = pool.reserveB ?? pool.quoteAmount ?? pool.amountB;
    const decA = pool.decimalsA ?? TOKEN_DECIMALS[aMint] ?? 0;
    const decB = pool.decimalsB ?? TOKEN_DECIMALS[bMint] ?? 0;
    if (!ra || !rb) return null;
    const a = Number(ra);
    const b = Number(rb);
    if (a <= 0 || b <= 0) return null;
    const price = (b / (10 ** decB)) / (a / (10 ** decA));
    return price;
  } catch (e) {
    return null;
  }
}

// Build & send single-leg Jupiter swap (if Jupiter returns swapTransaction or transactions)
async function executeJupiterRoute(routeObj) {
  try {
    const res = await fetch(JUPITER_SWAP, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        route: routeObj,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapUnwrapSOL: false
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('Jupiter swap failed: ' + txt.slice(0, 500));
    }
    const payload = await res.json();
    // If Jupiter returns swapTransaction (base64 signed/unsigned), prefer that
    if (payload.swapTransaction) {
      // it's often unsigned; try to deserialize and sign (legacy)
      try {
        const tx = Transaction.from(Buffer.from(payload.swapTransaction, 'base64'));
        tx.partialSign(wallet);
        const signed = tx.serialize();
        const txid = await connection.sendRawTransaction(signed, { skipPreflight: false });
        await connection.confirmTransaction(txid, 'confirmed');
        return txid;
      } catch (e) {
        // fallback: sometimes payload.transactions[] is present (v0)
      }
    }
    if (payload.transactions && payload.transactions.length > 0) {
      // pick first transaction (usually the main one). It contains a message base64
      const t0 = payload.transactions[0];
      if (t0.message) {
        // MessageV0.deserialize may be available — use VersionedTransaction path
        try {
          const msg = MessageV0.deserialize(Buffer.from(t0.message, 'base64'));
          const vt = new VersionedTransaction(msg);
          vt.sign([wallet]);
          const txid = await connection.sendRawTransaction(vt.serialize(), { skipPreflight: false });
          await connection.confirmTransaction(txid, 'confirmed');
          return txid;
        } catch (e) {
          throw new Error('Failed to sign/send Jupiter v0 tx: ' + e.message);
        }
      }
    }
    throw new Error('No usable transaction returned by Jupiter');
  } catch (e) {
    throw e;
  }
}

// === Core arbitrage scan ===
async function checkArbitrage() {
  try {
    if (!WATCH_TOKENS || WATCH_TOKENS.length < 2) return;
    // refresh caches
    await refreshTokenDecimals();
    await refreshRaydiumPools();

    // for each unordered pair check Jupiter vs Raydium
    for (let i = 0; i < WATCH_TOKENS.length; i++) {
      for (let j = i + 1; j < WATCH_TOKENS.length; j++) {
        const a = WATCH_TOKENS[i];
        const b = WATCH_TOKENS[j];

        // 1) Jupiter price A->B
        const jAB = await jupiterDerivedPrice(a, b, SAMPLE_AMOUNT_UI);
        const jBA = await jupiterDerivedPrice(b, a, SAMPLE_AMOUNT_UI);

        // 2) Raydium price (if pool exists)
        let rAB = null;
        let rBA = null;
        if (RAYDIUM_POOLS) {
          const poolAB = RAYDIUM_POOLS.get(`${a}|${b}`);
          if (poolAB) rAB = raydiumPoolPrice(poolAB, a, b);
          const poolBA = RAYDIUM_POOLS.get(`${b}|${a}`);
          if (poolBA) rBA = raydiumPoolPrice(poolBA, b, a);
        }

        // build price objects (source, price)
        const pricesAB = [];
        const pricesBA = [];
        if (jAB && jAB.price) pricesAB.push({ src: 'jupiter', price: jAB.price, route: jAB.route });
        if (rAB) pricesAB.push({ src: 'raydium', price: rAB });
        if (jBA && jBA.price) pricesBA.push({ src: 'jupiter', price: jBA.price, route: jBA.route });
        if (rBA) pricesBA.push({ src: 'raydium', price: rBA });

        if (pricesAB.length < 1 || pricesBA.length < 1) continue;

        // Compare best buy price (lowest) vs best sell price (highest)
        const bestBuy = pricesAB.reduce((min, p) => (p.price < min.price ? p : min), pricesAB[0]);
        const bestSell = pricesBA.reduce((max, p) => (p.price > max.price ? p : max), pricesBA[0]);

        // Spread: buy A->B at bestBuy.price, then sell B->A at bestSell.price
        // If bestSell.price > 1/bestBuy.price then cycle yields profit; simpler compute relative spread as (sellPrice - 1/buyPrice) / (1/buyPrice)
        // But our prices are "how many B per A". Converting:
        // If you start 1 A -> you get (bestBuy.price) B. Swap back: that amount B -> (bestBuy.price * bestSell.price) A.
        // profitPct = (finalA - 1) / 1 = (bestBuy.price * bestSell.price) - 1
        const finalA = bestBuy.price * bestSell.price;
        const profitPct = finalA - 1;

        // Attempt to estimate USD profit if STABLE_MINT is set: get base token price in USD via jupiterDerivedPrice(a, STABLE_MINT)
        let estProfitUSD = null;
        if (STABLE_MINT) {
          const priceAtoStable = await jupiterDerivedPrice(a, STABLE_MINT, 1);
          if (priceAtoStable && priceAtoStable.price) {
            // If we would trade SAMPLE_AMOUNT_UI of A:
            const startUsd = SAMPLE_AMOUNT_UI * priceAtoStable.price;
            estProfitUSD = startUsd * profitPct;
          }
        }

        // Decide if candidate is worth notifying/executing
        const spreadPct = profitPct * 100; // percent
        const meetsPct = profitPct > 0.0025; // >0.25% raw
        const meetsUsd = estProfitUSD !== null ? estProfitUSD >= MIN_PROFIT_USD : true; // if USD unknown, allow by pct
        if (meetsPct && meetsUsd) {
          const buySrc = bestBuy.src;
          const sellSrc = bestSell.src;
          const messageLines = [
            `⚡ *Arb candidate detected*`,
            `Pair: ${a} ⇄ ${b}`,
            `Buy on: ${buySrc} (A→B) price = ${bestBuy.price}`,
            `Sell on: ${sellSrc} (B→A) price = ${bestSell.price}`,
            `Estimated round-trip profit: ${ (profitPct * 100).toFixed(3) }%`
          ];
          if (estProfitUSD !== null) messageLines.push(`Estimated profit (USD): $${estProfitUSD.toFixed(2)} for ${SAMPLE_AMOUNT_UI} A`);
          messageLines.push(`Execute automatically: ${ENABLE_EXECUTE ? 'YES' : 'NO (ENABLE_EXECUTE=false)'}`);
          const msg = messageLines.join('\n');
          console.log(msg);
          await telegramSend(msg);

          // If allowed, attempt to execute a single-leg Jupiter swap to capture one side of the arbitrage.
          // NOTE: the safe way is to build an atomic multi-leg using Jupiter, but here we attempt the buy leg and hope aggregator routes route across DEXs.
          if (ENABLE_EXECUTE && bestBuy.route) {
            try {
              const txid = await executeJupiterRoute(bestBuy.route);
              await telegramSend(`✅ Executed buy leg via Jupiter: ${txid}`);
            } catch (e) {
              console.error('Execution failed:', e?.message || e);
              await telegramSend(`❌ Execution failed: ${(e.message || e).slice(0, 300)}`);
            }
          }
        }
      } // end j loop
    } // end i loop
  } catch (err) {
    console.warn('checkArbitrage error', err?.message || err);
  }
}

// === Start scanning loop if enabled ===
if (ENABLE_SCAN) {
  console.log(`🔁 Auto-scan enabled. Interval: ${SCAN_INTERVAL_MS}ms`);
  // initial run
  setImmediate(() => { checkArbitrage().catch(e => console.warn('initial scan failed', e)); });
  setInterval(() => checkArbitrage().catch(e => console.warn('scan failed', e)), SCAN_INTERVAL_MS);
} else {
  console.log('⏸ Auto-scan disabled. Set ENABLE_SCAN=true to enable.');
}

// === HTTP server for Render health check ===
const port = process.env.PORT || 3000;
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`🌐 Health check server listening on port ${port}`);
});

// === Launch Telegram bot ===
bot.launch().then(() => {
  console.log('🤖 Telegram bot is running...');
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
