// index.js
import 'dotenv/config';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import { createServer } from 'http';
import { Connection, Keypair, Transaction, MessageV0, VersionedTransaction } from '@solana/web3.js';
import { Telegraf } from 'telegraf';

// ----------------- Config (env-friendly) -----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TG_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || '';
const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID || '';

const MEV_RELAY = process.env.MEV_RELAY || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

const ENABLE_SCAN = process.env.ENABLE_SCAN === 'true';
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000); // default 30s
const SAMPLE_AMOUNT_UI = Number(process.env.SAMPLE_AMOUNT_UI || 1);
const SAMPLE_AMOUNT_USD = Number(process.env.SAMPLE_AMOUNT_USD || 100);
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 7);
const MAX_TRADE_SIZE_USD = Number(process.env.MAX_TRADE_SIZE_USD || 500);
const WATCH_TOKENS = (process.env.WATCH_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const STABLE_MINT = process.env.STABLE_MINT || ''; // optional

// Jupiter endpoints
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_TOKENS = 'https://quote-api.jup.ag/v6/tokens';

// Raydium public liquidity list
const RAYDIUM_LIQUIDITY_JSON = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

// ----------------- Setup -----------------
const relay = MEV_RELAY || SOLANA_RPC;
console.log(relay === MEV_RELAY ? `✅ Using MEV_RELAY: ${relay}` : `⚠️ Using SOLANA_RPC fallback: ${relay}`);
const connection = new Connection(relay, 'confirmed');

// Wallet loader (accept base58 OR JSON array)
let wallet;
try {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) throw new Error('PRIVATE_KEY env missing');
  let secretBytes;
  try {
    // try base58 first
    secretBytes = bs58.decode(raw);
  } catch (e) {
    // try JSON array (like [12,34,...])
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error('PRIVATE_KEY not array');
      secretBytes = Uint8Array.from(arr);
    } catch (e2) {
      throw new Error('PRIVATE_KEY is neither base58 nor JSON array');
    }
  }
  wallet = Keypair.fromSecretKey(secretBytes);
  console.log('🔑 Wallet loaded:', wallet.publicKey.toBase58());
} catch (e) {
  console.error('Failed to load wallet:', e.message);
  process.exit(1);
}

// Telegram bot
const bot = new Telegraf(TELEGRAM_TOKEN);

// Helper: Telegram notify (admin channel / chat id)
async function telegramSend(text) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return console.debug('telegram not configured', text.slice(0, 200));
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error('telegramSend failed:', err?.message || err);
  }
}

// ----------------- Caches & Refresh -----------------
let tokenCache = []; // tokens from Jupiter v6
let tokenDecimals = {}; // address -> decimals
let poolCache = []; // raw Raydium pool array
let poolMap = null;  // map key a|b -> pool

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${txt.slice(0,200)}`);
  }
  return res.json();
}

async function refreshTokens() {
  try {
    const data = await fetchJson(JUPITER_TOKENS);
    if (!Array.isArray(data)) {
      console.warn('Jupiter tokens response unexpected; got non-array');
      return;
    }
    tokenCache = data;
    tokenDecimals = {};
    for (const t of tokenCache) {
      if (t.address && typeof t.decimals === 'number') tokenDecimals[t.address] = t.decimals;
    }
    console.log(`✅ Jupiter tokens loaded: ${tokenCache.length}`);
  } catch (e) {
    console.warn('Failed to refresh tokens:', e.message);
  }
}

async function refreshPools() {
  try {
    const data = await fetchJson(RAYDIUM_LIQUIDITY_JSON);
    // some responses provide { official: [...], unOfficial: [...] } or a flat array
    let arr = [];
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.official) || Array.isArray(data.unOfficial)) {
      arr = (data.official || []).concat(data.unOfficial || []);
    }
    poolCache = arr;
    // build fast lookup map
    const m = new Map();
    for (const p of poolCache) {
      const a = p.tokenMintA || p.baseMint;
      const b = p.tokenMintB || p.quoteMint;
      if (!a || !b) continue;
      m.set(`${a}|${b}`, p);
      m.set(`${b}|${a}`, p);
    }
    poolMap = m;
    console.log(`✅ Raydium pools loaded: ${poolCache.length}`);
  } catch (e) {
    console.warn('Failed to refresh pools:', e.message);
    poolCache = [];
    poolMap = null;
  }
}

// Refresh both, with backoff on failure
async function refreshDataOnce() {
  await refreshTokens();
  await refreshPools();
}

// schedule refresh every 10 minutes
setInterval(() => {
  refreshDataOnce().catch(e => console.warn('refreshDataOnce error', e.message));
}, 10 * 60 * 1000);

// initial fetch (don't let top-level await block if environment doesn't support it)
// run at startup
refreshDataOnce().catch(e => console.warn('initial refresh failed', e.message));

// ----------------- Price helpers -----------------

// Jupiter quote-based derived price: returns price = (output units per 1 input unit)
async function jupiterDerivedPrice(inputMint, outputMint, amountUi = 1) {
  try {
    const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`;
    const data = await fetchJson(url);
    // data.data is present for v6 quote
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;
    const route = data.data[0];
    const inAmount = BigInt(route.inAmount || '0');
    const outAmount = BigInt(route.outAmount || '0');
    const decIn = tokenDecimals[inputMint] ?? 0;
    const decOut = tokenDecimals[outputMint] ?? 0;
    if (inAmount === 0n) return null;
    // price = (out / 10^decOut) / (in / 10^decIn) = (Number(out) * 10^decIn) / (Number(in) * 10^decOut)
    const price = (Number(outAmount) * (10 ** decIn)) / (Number(inAmount) * (10 ** decOut));
    return { price, route };
  } catch (e) {
    // If rate limited, bubble up message
    console.warn('jupiterDerivedPrice failed:', e.message?.slice(0,120) || e);
    return null;
  }
}

// Raydium pool price (B per A)
function raydiumPoolPrice(pool, aMint, bMint) {
  try {
    if (!pool) return null;
    const ra = pool.reserveA ?? pool.baseAmount ?? pool.amountA ?? pool.amount;
    const rb = pool.reserveB ?? pool.quoteAmount ?? pool.amountB ?? pool.total;
    const decA = pool.decimalsA ?? tokenDecimals[aMint] ?? 0;
    const decB = pool.decimalsB ?? tokenDecimals[bMint] ?? 0;
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

// ----------------- Arbitrage scanner (logs only) -----------------
let runningScan = false;
async function checkArbitrage() {
  if (runningScan) return; // avoid overlapping scans
  runningScan = true;
  try {
    if (!WATCH_TOKENS || WATCH_TOKENS.length < 2) {
      console.log('No WATCH_TOKENS configured. Set WATCH_TOKENS=MINT1,MINT2,... in env.');
      return;
    }
    if (!tokenCache.length) {
      console.log('Token cache empty; waiting for initial refresh.');
      return;
    }
    console.log('🔍 Running arbitrage scan for', WATCH_TOKENS.length, 'tokens');

    // iterate unordered pairs
    for (let i = 0; i < WATCH_TOKENS.length; i++) {
      for (let j = i + 1; j < WATCH_TOKENS.length; j++) {
        const a = WATCH_TOKENS[i];
        const b = WATCH_TOKENS[j];
        try {
          // Jupiter prices
          const jAB = await jupiterDerivedPrice(a, b, SAMPLE_AMOUNT_UI);
          const jBA = await jupiterDerivedPrice(b, a, SAMPLE_AMOUNT_UI);

          // Raydium pool prices
          const poolAB = poolMap ? poolMap.get(`${a}|${b}`) : null;
          const poolBA = poolMap ? poolMap.get(`${b}|${a}`) : null;
          const rAB = poolAB ? raydiumPoolPrice(poolAB, a, b) : null;
          const rBA = poolBA ? raydiumPoolPrice(poolBA, b, a) : null;

          // collate available sources
          const pricesAB = []; // price of B per 1 A
          const pricesBA = [];
          if (jAB && jAB.price) pricesAB.push({ src: 'jupiter', price: jAB.price, route: jAB.route });
          if (rAB) pricesAB.push({ src: 'raydium', price: rAB });
          if (jBA && jBA.price) pricesBA.push({ src: 'jupiter', price: jBA.price, route: jBA.route });
          if (rBA) pricesBA.push({ src: 'raydium', price: rBA });

          if (pricesAB.length === 0 || pricesBA.length === 0) continue;

          // choose cheapest buy (lowest B per A) and best sell (highest A per B? but we've defined BA as B->A price so it's A per 1 B)
          // Actually our BA price is A_per_B since jupiterDerivedPrice(b,a) returns amount A per 1 B.
          const bestBuy = pricesAB.reduce((min, p) => p.price < min.price ? p : min, pricesAB[0]);
          const bestSell = pricesBA.reduce((max, p) => p.price > max.price ? p : max, pricesBA[0]);

          // Round-trip: start with 1 A -> get bestBuy.price B -> swap B -> get bestBuy.price * bestSell.price A
          const finalA = bestBuy.price * bestSell.price;
          const profitPct = finalA - 1; // e.g., 0.02 = 2%
          const profitPctDisplay = (profitPct * 100).toFixed(4);

          // estimate USD profit by simply multiplying SAMPLE_AMOUNT_USD by profitPct
          const estProfitUSD = SAMPLE_AMOUNT_USD * profitPct;

          // Heuristics: require >0.25% and estimated USD >= MIN_PROFIT_USD and SAMPLE_AMOUNT_USD <= MAX_TRADE_SIZE_USD
          if (profitPct > 0.0025 && estProfitUSD >= MIN_PROFIT_USD && SAMPLE_AMOUNT_USD <= MAX_TRADE_SIZE_USD) {
            const text = [
              '⚡ *Arb candidate detected*',
              `Pair: ${a} ⇄ ${b}`,
              `Buy (A→B) on: ${bestBuy.src} price = ${bestBuy.price}`,
              `Sell (B→A) on: ${bestSell.src} price = ${bestSell.price}`,
              `Round-trip profit: ${profitPctDisplay}%`,
              `Estimated profit (USD): $${estProfitUSD.toFixed(2)} (using \$${SAMPLE_AMOUNT_USD} nominal)`,
              `Execution: *NO* (logging only)`
            ].join('\n');
            console.log(text);
            await telegramSend(text);
          } // end heuristic
        } catch (pairErr) {
          // per-pair errors shouldn't kill the loop
          console.warn(`pair ${a}|${b} error:`, pairErr?.message || pairErr);
        }
      }
    }
  } finally {
    runningScan = false;
  }
}

// schedule scans
if (ENABLE_SCAN) {
  console.log(`🔁 Auto-scan enabled (interval ${SCAN_INTERVAL_MS}ms)`);
  // initial immediate run after small delay to allow caches to populate
  setTimeout(() => {
    checkLoop();
  }, 2000);
  // repeated runs
  setInterval(() => {
    checkLoop();
  }, SCAN_INTERVAL_MS);
} else {
  console.log('⏸ Auto-scan disabled. Set ENABLE_SCAN=true to enable.');
}

// wrap the check function to ensure caches exist
async function checkLoop() {
  try {
    // if caches empty, try to refresh once more (non-blocking)
    if (!tokenCache.length || !poolCache.length) {
      await refreshDataOnce();
    }
    await checkArbitrage();
  } catch (e) {
    console.warn('checkLoop error', e?.message || e);
  }
}

// ----------------- Telegram commands -----------------
bot.start((ctx) => ctx.reply('🚀 Arb bot alive. Use /balance /rpc /scan'));
bot.command('balance', async (ctx) => {
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    ctx.reply(`Balance: ${(bal / 1e9).toFixed(6)} SOL`);
  } catch (e) {
    ctx.reply('Balance error: ' + (e?.message || e));
  }
});
bot.command('rpc', (ctx) => ctx.reply(`Active RPC: ${relay}`));
bot.command('scan', async (ctx) => {
  await ctx.reply('Manual scan started');
  await checkLoop();
  await ctx.reply('Manual scan finished');
});

// ----------------- Health server -----------------
const port = Number(process.env.PORT || 3000);
createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(port, () => console.log(`🌐 Health server listening on ${port}`));

// ----------------- Launch bot -----------------
bot.launch().then(() => console.log('🤖 Telegram bot launched')).catch(e=>console.error('Bot launch failed', e));
