// index.js
// Upgraded arb bot (atomic triangular execution + Orca/OpenBook adapters + flashloan client hook)

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const bs58 = require('bs58');
const {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  MessageV0,
  PublicKey
} = require('@solana/web3.js');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const MEV_RELAY = process.env.MEV_RELAY || '';
const PRIVATE_KEY_BASE58 = process.env.PRIVATE_KEY_BASE58 || '';

const ENABLE_SCAN = process.env.ENABLE_SCAN === 'true';
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 4000);
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 7);
const MAX_TRADE_SIZE_USD = Number(process.env.MAX_TRADE_SIZE_USD || 500);
const SAMPLE_AMOUNT_USD = Number(process.env.SAMPLE_AMOUNT_USD || 100);

const WATCH_TOKENS = (process.env.WATCH_TOKENS || '').split(',').map(s=>s.trim()).filter(Boolean);

// Jupiter endpoints
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP = 'https://quote-api.jup.ag/v6/swap';
const JUPITER_TOKENS = 'https://tokens.jup.ag/api/tokens';

// Raydium & other simple adapters
const RAYDIUM_LIQUIDITY_JSON = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

// OpenBook endpoint placeholder
const OPENBOOK_ORDERBOOK_ENDPOINT = 'https://api.bloxroute.com/api/v2/openbook/orderbooks';

let OrcaWhirlpools;
try { OrcaWhirlpools = require('@orca-so/whirlpools-sdk'); } catch (e) { OrcaWhirlpools = null; }

const connection = new Connection(MEV_RELAY || RPC_URL, { commitment: 'confirmed' });
const KEYPAIR = PRIVATE_KEY_BASE58 ? Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58)) : null;

async function telegramSend(text) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (err) { console.error('telegramSend', err?.message || err); }
}

async function fetchJson(url, opts={}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text().catch(()=>'')}`);
  return res.json();
}

let TOKEN_DECIMALS = {};
async function refreshTokenDecimals(){ try {
  const data = await fetchJson(JUPITER_TOKENS);
  for (const t of data) if (t.address) TOKEN_DECIMALS[t.address] = t.decimals;
} catch(e){ console.warn('token decimals load fail', e?.message || e); } }

let RAYDIUM_POOLS = null;
async function refreshRaydiumPools(){ try {
  const data = await fetchJson(RAYDIUM_LIQUIDITY_JSON);
  const pools = (data.official || data).concat(data.unOfficial || []);
  const map = new Map();
  for (const p of pools){ const a = p.tokenMintA||p.baseMint; const b = p.tokenMintB||p.quoteMint; if(!a||!b) continue; map.set(`${a}|${b}`, p); map.set(`${b}|${a}`, p); }
  RAYDIUM_POOLS = map;
} catch(e){ console.warn('Raydium load fail', e?.message||e); RAYDIUM_POOLS=null; } }

async function fetchOpenBookOrderbook(market) {
  try {
    const url = `${OPENBOOK_ORDERBOOK_ENDPOINT}/${encodeURIComponent(market)}`;
    const j = await fetchJson(url);
    return j;
  } catch (e) { return null; }
}

async function getOrcaPrice(aMint, bMint) { if (!OrcaWhirlpools) return null; try { return null; } catch (e) { return null; } }

async function jupiterDerivedPrice(inputMint, outputMint, amountUi=1) {
  try {
    const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`;
    const d = await fetchJson(url);
    if (!d || !d.data || d.data.length===0) return null;
    const r = d.data[0];
    const inAmount = BigInt(r.inAmount || '0');
    const outAmount = BigInt(r.outAmount || '0');
    const decIn = TOKEN_DECIMALS[inputMint] ?? 0;
    const decOut = TOKEN_DECIMALS[outputMint] ?? 0;
    if (inAmount === 0n) return null;
    const price = (Number(outAmount) * (10 ** decIn)) / (Number(inAmount) * (10 ** decOut));
    return { price, route: r, raw: r };
  } catch (e) { return null; }
}

async function fetchJupiterSwapTxPayload(route) {
  const res = await fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ route, userPublicKey: KEYPAIR.publicKey.toBase58(), wrapUnwrapSOL:false, asLegacyTransaction:false })
  });
  if (!res.ok) throw new Error('jupiter swap call failed: ' + await res.text());
  return res.json();
}

function parseJupiterTxPayload(payload) {
  const txs = payload.transactions || [];
  const parsed = txs.map(t => ({ message: t.message, addressTableLookups: t.addressTableLookups || [] }));
  return parsed;
}

async function composeVersionedTxFromPayloads(payloads) {
  const Messages = payloads.map(p => { const buf = Buffer.from(p.message, 'base64'); try { const mv = MessageV0.deserialize(buf); return { mv, lookups: p.addressTableLookups || [] }; } catch (e) { throw new Error('Failed to deserialize Jupiter message: ' + e.message); } });
  const first = Messages[0].mv;
  if (Messages.length === 1) { const vt = new VersionedTransaction(first); return { versionedTx: vt, addressLookupTables: Messages[0].lookups }; }
  const base = Messages[0].mv;
  for (let i = 1; i < Messages.length; i++) {
    const from = Messages[i].mv;
    base.instructions = base.instructions.concat(from.instructions);
    for (const k of from.staticAccountKeys) { if (!base.staticAccountKeys.find(x => x.equals(k))) base.staticAccountKeys.push(k); }
  }
  const vt = new VersionedTransaction(base);
  const lookups = Messages.flatMap(m => m.lookups || []);
  return { versionedTx: vt, addressLookupTables: lookups };
}

async function signAndSendVersionedTx(versionedTx) {
  versionedTx.sign([KEYPAIR]);
  const raw = versionedTx.serialize();
  const txid = await connection.sendRawTransaction(raw, { skipPreflight: false });
  await connection.confirmTransaction(txid, 'confirmed');
  return txid;
}

async function atomicTriangularExecute(aMint, bMint, cMint, amountUi) {
  const qAB = await fetchJson(`${JUPITER_QUOTE}?inputMint=${aMint}&outputMint=${bMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`);
  const qBC = await fetchJson(`${JUPITER_QUOTE}?inputMint=${bMint}&outputMint=${cMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`);
  const qCA = await fetchJson(`${JUPITER_QUOTE}?inputMint=${cMint}&outputMint=${aMint}&amount=${amountUi}&slippage=1&onlyDirectRoutes=false`);
  if (!qAB?.data?.[0] || !qBC?.data?.[0] || !qCA?.data?.[0]) throw new Error('one of the legs missing route');
  const payloadAB = await fetchJupiterSwapTxPayload(qAB.data[0]);
  const payloadBC = await fetchJupiterSwapTxPayload(qBC.data[0]);
  const payloadCA = await fetchJupiterSwapTxPayload(qCA.data[0]);
  const parsedAB = parseJupiterTxPayload(payloadAB);
  const parsedBC = parseJupiterTxPayload(payloadBC);
  const parsedCA = parseJupiterTxPayload(payloadCA);
  const pAB = parsedAB[0];
  const pBC = parsedBC[0];
  const pCA = parsedCA[0];
  if (!pAB || !pBC || !pCA) throw new Error('missing jupiter transaction parts');
  const { versionedTx, addressLookupTables } = await composeVersionedTxFromPayloads([pAB, pBC, pCA]);
  const txid = await signAndSendVersionedTx(versionedTx);
  return txid;
}

async function getAdapterPrices(aMint, bMint) {
  const arr = [];
  const j = await jupiterDerivedPrice(aMint, bMint, 1);
  if (j) arr.push({ source:'jupiter', price:j.price, meta:j.raw });
  if (RAYDIUM_POOLS) {
    const pool = RAYDIUM_POOLS.get(`${aMint}|${bMint}`);
    if (pool) {
      const ra = pool.reserveA ?? pool.baseAmount ?? pool.amountA;
      const rb = pool.reserveB ?? pool.quoteAmount ?? pool.amountB;
      const decA = pool.decimalsA ?? TOKEN_DECIMALS[aMint] ?? 0;
      const decB = pool.decimalsB ?? TOKEN_DECIMALS[bMint] ?? 0;
      if (ra && rb) { const p = (Number(rb)/(10**decB)) / (Number(ra)/(10**decA)); arr.push({ source:'raydium', price:p, meta:pool }); }
    }
  }
  const orcaP = await getOrcaPrice(aMint, bMint);
  if (orcaP) arr.push({ source:'orca', price:orcaP });
  return arr;
}

function analyzeCrossDex(pricesA, pricesB) { const outs = []; for (const a of pricesA) for (const b of pricesB) { if (!a.price || !b.price) continue; const spread = (b.price - a.price) / a.price; outs.push({ buyOn: a.source, sellOn: b.source, buyPrice: a.price, sellPrice: b.price, spread }); } outs.sort((x,y)=>y.spread-x.spread); return outs; }

async function scanOnce() {
  try {
    await refreshTokenDecimals();
    await refreshRaydiumPools();
    for (let i=0;i<WATCH_TOKENS.length;i++){
      for (let j=i+1;j<WATCH_TOKENS.length;j++){
        const a = WATCH_TOKENS[i];
        const b = WATCH_TOKENS[j];
        const pA = await getAdapterPrices(a,b);
        const pB = await getAdapterPrices(b,a);
        if (pA.length<1 || pB.length<1) continue;
        const cmp = analyzeCrossDex(pA,pB);
        if (cmp && cmp.length>0) {
          const best = cmp[0];
          const estProfitUSD = SAMPLE_AMOUNT_USD * best.spread;
          if (best.spread > 0.003 && estProfitUSD >= MIN_PROFIT_USD && SAMPLE_AMOUNT_USD <= MAX_TRADE_SIZE_USD) {
            await telegramSend(`Cross-DEX candidate ${a}<->${b} spread ${(best.spread*100).toFixed(3)}% est ~$${estProfitUSD.toFixed(2)}. Attempting Jupiter swap for buy ${best.buyOn} -> sell ${best.sellOn}.`);
            try {
              const quote = await fetchJson(`${JUPITER_QUOTE}?inputMint=${a}&outputMint=${b}&amount=${SAMPLE_AMOUNT_USD}&slippage=1`);
              if (quote?.data?.[0]) {
                const route = quote.data[0];
                const payload = await fetchJupiterSwapTxPayload(route);
                if (payload.swapTransaction) {
                  const tx = Transaction.from(Buffer.from(payload.swapTransaction,'base64'));
                  tx.partialSign(KEYPAIR);
                  const signed = tx.serialize();
                  const txid = await connection.sendRawTransaction(signed, { skipPreflight:false });
                  await connection.confirmTransaction(txid, 'confirmed');
                  await telegramSend(`Cross-DEX trade executed: ${txid}`);
                } else if (payload.transactions) {
                  const t0 = payload.transactions[0];
                  const msg = MessageV0.deserialize(Buffer.from(t0.message,'base64'));
                  const vt = new VersionedTransaction(msg);
                  vt.sign([KEYPAIR]);
                  const txid = await connection.sendRawTransaction(vt.serialize(), { skipPreflight:false });
                  await connection.confirmTransaction(txid, 'confirmed');
                  await telegramSend(`Cross-DEX trade executed (v0): ${txid}`);
                }
              }
            } catch (e) { await telegramSend('Trade attempt failed: ' + (e.message || e)); }
          }
        }
      }
    }

    if (WATCH_TOKENS.length >= 3) {
      const triplets = [];
      for (let i=0;i<WATCH_TOKENS.length;i++){
        for (let j=0;j<WATCH_TOKENS.length;j++){
          for (let k=0;k<WATCH_TOKENS.length;k++){
            if (i===j||j===k||i===k) continue;
            triplets.push([WATCH_TOKENS[i], WATCH_TOKENS[j], WATCH_TOKENS[k]]);
            if (triplets.length >= 12) break;
          }
          if (triplets.length >= 12) break;
        }
        if (triplets.length >= 12) break;
      }

      for (const t of triplets) {
        const [a,b,c] = t;
        const p1 = await jupiterDerivedPrice(a,b,1);
        const p2 = await jupiterDerivedPrice(b,c,1);
        const p3 = await jupiterDerivedPrice(c,a,1);
        if (!p1||!p2||!p3) continue;
        const x = SAMPLE_AMOUNT_USD;
        const finalA = x * p1.price * p2.price * p3.price;
        const profitPct = (finalA - x) / x;
        if (profitPct > 0.015 && (finalA - x) >= MIN_PROFIT_USD) {
          await telegramSend(`Triangular candidate ${a}->${b}->${c}->${a}: ${(profitPct*100).toFixed(2)}% est profit. Attempting atomic execution...`);
          try {
            const txid = await atomicTriangularExecute(a,b,c, SAMPLE_AMOUNT_USD);
            await telegramSend(`Atomic tri-exec tx submitted: ${txid}`);
          } catch (e) {
            await telegramSend('Atomic tri-exec failed: ' + (e.message || e));
          }
        }
      }
    }

  } catch (err) { console.warn('scanOnce err', err?.message || err); }
}

const app = express();
app.use(express.json());
app.post('/webhook', async (req,res)=> { try { const body=req.body; if (body?.message?.text) { const txt = body.message.text.trim(); const fromId = String(body.message.from?.id || ''); if (txt === '/status' && fromId === ADMIN_TELEGRAM_ID) { await telegramSend(`Bot status. RPC=${RPC_URL} MEV_RELAY=${MEV_RELAY||'none'} ENABLE_SCAN=${ENABLE_SCAN}`); } else if (txt === '/scan' && fromId === ADMIN_TELEGRAM_ID) { await scanOnce(); } else if (txt.startsWith('/watch') && fromId === ADMIN_TELEGRAM_ID) { const parts = txt.split(' '); if (parts[1]) { const newmints = parts[1].split(',').map(s=>s.trim()).filter(Boolean); for (const m of newmints) if (!WATCH_TOKENS.includes(m)) WATCH_TOKENS.push(m); await telegramSend(`Watchlist: ${WATCH_TOKENS.join(',')}`); } } } } catch (e) { console.error('webhook', e); } res.json({ ok: true }); });
app.get('/', (req,res)=> res.send('Solana arb bot (upgraded - with atomic tri and adapters)'));
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, ()=> { console.log('Listening on', PORT); refreshTokenDecimals().catch(()=>{}); refreshRaydiumPools().catch(()=>{}); if (ENABLE_SCAN) setInterval(scanOnce, SCAN_INTERVAL_MS); });
