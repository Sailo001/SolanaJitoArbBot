require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'processed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

// ------------ on-chain CLOB (OpenBook v2) ------------
const OB_PROGRAM = new PublicKey('opnb2LAfJYbRMAHHvBJp4pR9u8P5gAGqJ7d6Fj9LqN6');

// ------------ constant-product AMM (Raydium) ------------
const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// ------------ minimal helpers ------------
const getObPrice = async (mintIn, mintOut, size) => {
  // fetch order-book (gPA + decode)
  const filters = [
    { memcmp: { offset: 24, bytes: mintIn.toBase58() } },
    { memcmp: { offset: 56, bytes: mintOut.toBase58() } },
  ];
  const accs = await conn.getProgramAccounts(OB_PROGRAM, { filters, dataSlice: { offset: 0, length: 8 } });
  if (accs.length === 0) return null;
  const ob = await conn.getAccountInfo(accs[0].pubkey);
  if (!ob) return null;
  const data = ob.data;
  // first ask price (offset 400 + 64 + 8)
  const askPrice = new BN(data.slice(400 + 64, 400 + 64 + 8), 'le');
  return Number(askPrice) / 1e9; // quote-lots → UI
};

const getAmmPrice = async (mintIn, mintOut, size) => {
  // fetch AMM v4 account
  const filters = [
    { memcmp: { offset: 400, bytes: mintIn.toBase58() } },
    { memcmp: { offset: 432, bytes: mintOut.toBase58() } },
  ];
  const accs = await conn.getProgramAccounts(RAYDIUM_AMM_V4, { filters, dataSlice: { offset: 0, length: 8 } });
  if (accs.length === 0) return null;
  const amm = await conn.getAccountInfo(accs[0].pubkey);
  if (!amm) return null;
  const data = amm.data;
  const coinAmount = new BN(data.slice(400 + 64, 400 + 64 + 8), 'le');
  const pcAmount   = new BN(data.slice(432 + 64, 432 + 64 + 8), 'le');
  const feeBp      = data[1072]; // basis points
  const inRes = mintIn.equals(SOL) ? coinAmount : pcAmount;
  const outRes = mintIn.equals(SOL) ? pcAmount : coinAmount;
  const inAmtLessFee = size.mul(new BN(10000 - feeBp)).div(new BN(10000));
  const numerator = inAmtLessFee.mul(outRes);
  const denominator = inRes.add(inAmtLessFee);
  const out = numerator.div(denominator);
  return Number(out) / 1e9;
};

// ------------ main loop ------------
const CYCLE_USD = 1_000; // $1 000 per cycle
setInterval(async () => {
  try {
    const usdc = new BN(CYCLE_USD * 1e6);
    // 1. Buy SOL on CLOB
    const obPrice = await getObPrice(USDC, SOL, usdc);
    if (!obPrice) return;
    const solGross = CYCLE_USD / obPrice;

    // 2. Sell SOL on AMM
    const ammOut = await getAmmPrice(SOL, USDC, new BN(solGross * 1e9));
    if (!ammOut) return;
    const usdcBack = ammOut;
    const profit   = usdcBack - CYCLE_USD;
    const profitPc = (profit / CYCLE_USD) * 100;

    if (profitPc > 0.25) { // after 0.05 % OB + 0.25 % AMM fees
      console.log('ARB:', profitPc.toFixed(2) + '%', 'Profit $', profit.toFixed(2));
      // TODO: build Jito bundle here
    } else {
      console.log('No arb > 0.25 %');
    }
  } catch (e) {
    console.error('Poll error', e.message);
  }
}, 3_000); // 3 s poll

console.log('Arb scanner live – $1 k cycles');
