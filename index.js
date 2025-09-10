// index.js (rate-limit and endpoint fixes + safer scanning defaults)
import 'dotenv/config';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import { createServer } from 'http';
import { Connection, Keypair } from '@solana/web3.js';
import { Telegraf } from 'telegraf';

/* ================== Config ================== */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TG_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || '';
const MEV_RELAY = process.env.MEV_RELAY || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

let SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000); // default 30s
const MIN_SCAN_INTERVAL_MS = 30000; // enforce 30s minimum
if (SCAN_INTERVAL_MS < MIN_SCAN_INTERVAL_MS) {
  console.warn(`SCAN_INTERVAL_MS (${SCAN_INTERVAL_MS}ms) is too low — enforcing minimum ${MIN_SCAN_INTERVAL_MS}ms`);
  SCAN_INTERVAL_MS = MIN_SCAN_INTERVAL_MS;
}

const ENABLE_SCAN = process.env.ENABLE_SCAN === 'true';
const SAMPLE_AMOUNT_UI = Number(process.env.SAMPLE_AMOUNT_UI || 1);
const SAMPLE_AMOUNT_USD = Number(process.env.SAMPLE_AMOUNT_USD || 100);
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 7);
const MAX_TRADE_SIZE_USD = Number(process.env.MAX_TRADE_SIZE_USD || 500);
const WATCH_TOKENS = (process.env.WATCH_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const STABLE_MINT = process.env.STABLE_MINT || '';

// Jupiter endpoints - note: prefer lite Token API V2
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_TOKENS_CANDIDATES = [
  'https://lite-api.jup.ag/tokens/v2',    // recommended (no API key)
  'https://api.jup.ag/tokens/v2',         // pro (may require API key / rate limits)
  'https://tokens.jup.ag/all',            // legacy mirror (sometimes available)
  'https://quote-api.jup.ag/v6/tokens'    // older - may 404
];

// Raydium liquidity (may be rate-limited)
const RAYDIUM_LIQUIDITY_JSON = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

/* Built-in token decimals fallback (common tokens) */
const BUILTIN_DECIMALS = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,  // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,  // USDT
  'So11111111111111111111111111111111111111112': 9   // wSOL (SOL)
};

/* ================== Setup connection & wallet ================== */
const relay = MEV_RELAY || SOLANA_RPC;
console.log(relay === MEV_RELAY ? `✅ Using MEV_RELAY: ${relay}` : `⚠️ Using SOLANA_RPC fallback: ${relay}`);
const connection = new Connection(relay, 'confirmed');

// wallet loader (accept base58 OR json array)
let wallet;
try {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) throw new Error('PRIVATE_KEY env missing');
  let secretBytes;
  try {
    secretBytes = bs58.decode(raw); // try base58
  } catch (e) {
    // fallback to JSON array string
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('PRIVATE_KEY not array');
    secretBytes = Uint8Array.from(arr);
  }
  wallet = Keypair.fromSecretKey(secretBytes);
  console.log('🔑 Wallet loaded:', wallet.publicKey.toBase58());
} catch (e) {
  console.error('Failed to load wallet:', e.message);
  process.exit(1);
}

/* ================== Telegram helper ================== */
const bot = new Telegraf(TELEGRAM_TOKEN);
async function telegramSend(text) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return console.debug('telegram not configured', text.slice(0,200));
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error('telegramSend failed:', err?.message || err);
  }
}

/* ================== Caches + backoff state ================== */
let tokenCache = [];           // array of token objects
let tokenDecimals = { ...BUILTIN_DECIMALS }; // address -> decimals (seeded)
let poolCache = [];            // Raydium raw array
let poolMap = null;            // Map 'mintA|mintB' -> pool

let tokenRetryDelay = 0; // ms (exponential backoff)
let poolRetryDelay = 0;

/* simple fetch wrapper that throws with status text */
async function fetchJson(url, opts={}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(()=>'');
    const err = new Error(`HTTP ${res.status} ${body.slice(0,120)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ================== Token refresh with exponential backoff ================== */
async function doRefreshTokens() {
  const endpoints = JUPITER_TOKENS_CANDIDATES;
  let lastErr = null;

  for (const ep of endpoints) {
    try {
      console.log(`Attempting Jupiter token list from: ${ep}`);
      const data = await fetchJson(ep);
      // handle different shapes: v2 lite might return { tokens: [...] } or array directly
      let arr = [];
      if (Array.isArray(data)) arr = data;
      else if (Array.isArray(data.tokens)) arr = data.tokens;
      else if (Array.isArray(data.data)) arr = data.data;
      else {
        // Unexpected shape — store raw and continue
        console.warn(`Unexpected token list shape from ${ep} — skipping`);
        lastErr = new Error('unexpected shape');
        continue;
      }
      if (!arr.length) { lastErr = new Error('empty token list'); continue; }

      tokenCache = arr;
      tokenDecimals = { ...BUILTIN_DECIMALS }; // reset then populate
      for (const t of tokenCache) {
        const addr = t.address || t.mint || t.id || t.key;
        const dec = t.decimals ?? t.decimal ?? t.tokenDecimals;
        if (addr && typeof dec === 'number') tokenDecimals[addr] = dec;
      }
      tokenRetryDelay = 10 * 60 * 1000; // success => next refresh in 10 min
      console.log(`✅ Token list loaded (${tokenCache.length} entries). Next refresh in ${tokenRetryDelay/60000}m`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`Failed to refresh tokens from ${ep}:`, err.message?.slice(0,120) || err);
      // If rate-limited, escalate backoff and stop trying further endpoints now
      if (err.status === 429) {
        tokenRetryDelay = tokenRetryDelay ? Math.min(tokenRetryDelay * 2, 60*60*1000) : 60 * 1000;
        console.warn(`Jupiter tokens rate-limited (429). Backoff set to ${tokenRetryDelay/1000}s`);
        break;
      }
      // otherwise try next endpoint
    }
  }

  // If we reach here, we failed to get tokens from any endpoint
  tokenCache = []; // keep it empty
  tokenRetryDelay = tokenRetryDelay ? Math.min(tokenRetryDelay * 2, 60*60*1000) : 30 * 1000;
  console.warn(`Token refresh failed; next attempt in ${tokenRetryDelay/1000}s — last error: ${lastErr?.message || 'unknown'}`);
}

/* schedule token refresh loop (self-scheduling via setTimeout to respect backoff) */
async function scheduleTokenRefreshLoop() {
  try {
    await doRefreshTokens();
  } catch (e) {
    console.warn('Token refresh loop top-level error', e?.message || e);
  } finally {
    setTimeout(scheduleTokenRefreshLoop, tokenRetryDelay || (10*60*1000));
  }
}

/* ================== Raydium pools refresh with backoff ================== */
async function doRefreshPools() {
  try {
    console.log(`Fetching Raydium pools from ${RAYDIUM_LIQUIDITY_JSON}`);
    const data = await fetchJson(RAYDIUM_LIQUIDITY_JSON);
    let arr = [];
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.official) || Array.isArray(data.unOfficial)) {
      arr = (data.official || []).concat(data.unOfficial || []);
    } else {
      // Unexpected shape - try to detect an inner property:
      arr = data.pools || [];
    }
    poolCache = arr;
    const m = new Map();
    for (const p of poolCache) {
      const a = p.tokenMintA || p.baseMint;
      const b = p.tokenMintB || p.quoteMint;
      if (!a || !b) continue;
      m.set(`${a}|${b}`, p);
      m.set(`${b}|${a}`, p);
    }
    poolMap = m;
    poolRetryDelay = 30 * 60 * 1000; // success => refresh every 30 minutes
    console.log(`✅ Raydium pools loaded (${poolCache.length}). Next refresh in ${poolRetryDelay/60000}m`);
  } catch (err) {
    console.warn('Failed to refresh pools:', err.message?.slice(0,120) || err);
    if (err.status === 429) {
      // rate-limited: increase delay
      poolRetryDelay = poolRetryDelay ? Math.min(poolRetryDelay * 2, 60*60*1000) : 10 * 60 * 1000;
      console.warn(`Raydium rate-limited; backoff now ${poolRetryDelay/60000}m`);
    } else {
      poolRetryDelay = poolRetryDelay ? Math.min(poolRetryDelay * 2, 60*60*1000) : 5 * 60 * 1000;
    }
  }
}

async function schedulePoolRefreshLoop() {
  try {
    await doRefreshPools();
  } catch (e) {
    console.warn('Pool refresh loop top-level error', e?.message || e);
  } finally {
    setTimeout(schedulePoolRefreshLoop, poolRetryDelay || (30*60*1000));
  }
}

/* ---------------- start refresh loops ---------------- */
scheduleTokenRefreshLoop(); // self-schedules with backoff
schedulePoolRefreshLoop();

/* ================== Price helpers ================== */
async function jupiterDerivedPrice(inputMint, outputMint, amountUi = 1) {
  try {
    const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;
    const route = data.data[0];
    const inAmount = BigInt(route.inAmount || '0');
    const outAmount = BigInt(route.outAmount || '0');
    const decIn = tokenDecimals[inputMint] ?? 0;
    const decOut = tokenDecimals[outputMint] ?? 0;
    if (inAmount === 0n) return null;
    const price = (Number(outAmount) * (10 ** decIn)) / (Number(inAmount) * (10 ** decOut));
    return { price, route };
  } catch (e) {
    console.warn('jupiterDerivedPrice error', e?.message?.slice(0,120) || e);
    return null;
  }
}

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
    return (b / (10 ** decB)) / (a / (10 ** decA));
  } catch (e) {
    return null;
  }
}

/* ================== Arbitrage scanner (logging only) ================== */
let runningScan = false;
async function checkArbitrage() {
  if (runningScan) return;
  runningScan = true;
  try {
    if (!WATCH_TOKENS.length) {
      console.log('No WATCH_TOKENS configured. Set env WATCH_TOKENS=MINT1,MINT2,...');
      return;
    }
    if (!tokenCache.length) {
      console.log('Token cache empty; waiting for token refresh (will not spam).');
      return;
    }

    for (let i = 0; i < WATCH_TOKENS.length; i++) {
      for (let j = i + 1; j < WATCH_TOKENS.length; j++) {
        const a = WATCH_TOKENS[i];
        const b = WATCH_TOKENS[j];
        try {
          const jAB = await jupiterDerivedPrice(a,b,SAMPLE_AMOUNT_UI);
          const jBA = await jupiterDerivedPrice(b,a,SAMPLE_AMOUNT_UI);
          const poolAB = poolMap ? poolMap.get(`${a}|${b}`) : null;
          const poolBA = poolMap ? poolMap.get(`${b}|${a}`) : null;
          const rAB = poolAB ? raydiumPoolPrice(poolAB,a,b) : null;
          const rBA = poolBA ? raydiumPoolPrice(poolBA,b,a) : null;

          const pricesAB = [];
          const pricesBA = [];
          if (jAB && jAB.price) pricesAB.push({ src:'jupiter', price:jAB.price });
          if (rAB) pricesAB.push({ src:'raydium', price:rAB });
          if (jBA && jBA.price) pricesBA.push({ src:'jupiter', price:jBA.price });
          if (rBA) pricesBA.push({ src:'raydium', price:rBA });

          if (pricesAB.length === 0 || pricesBA.length === 0) continue;

          const bestBuy = pricesAB.reduce((min,p)=>p.price<min.price?p:min, pricesAB[0]);
          const bestSell = pricesBA.reduce((max,p)=>p.price>max.price?p:max, pricesBA[0]);

          const finalA = bestBuy.price * bestSell.price;
          const profitPct = finalA - 1;
          const estProfitUSD = SAMPLE_AMOUNT_USD * profitPct;

          if (profitPct > 0.0025 && estProfitUSD >= MIN_PROFIT_USD && SAMPLE_AMOUNT_USD <= MAX_TRADE_SIZE_USD) {
            const msg = [
              '⚡ *Arb candidate detected*',
              `Pair: ${a} ⇄ ${b}`,
              `Buy (A→B): ${bestBuy.src} price ${bestBuy.price}`,
              `Sell (B→A): ${bestSell.src} price ${bestSell.price}`,
              `Round-trip profit: ${(profitPct*100).toFixed(3)}%`,
              `Est profit (USD): $${estProfitUSD.toFixed(2)} (nominal ${SAMPLE_AMOUNT_USD})`,
              'Execution: NO (logging only)'
            ].join('\n');
            console.log(msg);
            await telegramSend(msg);
          }
        } catch (pairErr) {
          console.warn(`Pair ${a}|${b} error:`, (pairErr?.message || pairErr).slice(0,200));
        }
      }
    }
  } finally {
    runningScan = false;
  }
}

/* schedule scanning */
if (ENABLE_SCAN) {
  console.log(`🔁 Auto-scan enabled. Interval ${SCAN_INTERVAL_MS}ms`);
  setTimeout(() => { checkArbitrage().catch(e => console.warn('initial scan failed', e?.message || e)); }, 2000);
  setInterval(() => checkArbitrage().catch(e => console.warn('scan failed', e?.message || e)), SCAN_INTERVAL_MS);
} else {
  console.log('⏸ Auto-scan disabled. Set ENABLE_SCAN=true');
}

/* ================== HTTP health server ================== */
const port = Number(process.env.PORT || 3000);
createServer((req,res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, {'Content-Type':'text/plain'});
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(port, () => console.log(`🌐 Health server listening on ${port}`));

/* ================== Telegram commands & launch ================== */
bot.start(ctx => ctx.reply('🚀 Arb bot alive. Use /balance /rpc /scan'));
bot.command('balance', async ctx => {
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    ctx.reply(`Balance: ${(bal/1e9).toFixed(6)} SOL`);
  } catch (e) { ctx.reply('Balance error: ' + (e?.message || e)); }
});
bot.command('rpc', ctx => ctx.reply(`Active RPC: ${relay}`));
bot.command('scan', async ctx => { ctx.reply('Manual scan started'); await checkArbitrage(); ctx.reply('Manual scan finished'); });

bot.launch().then(()=>console.log('🤖 Telegram bot launched')).catch(e=>console.error('Bot launch failed', e));
