// src/index.ts
import { Connection, Keypair } from '@solana/web3.js';
import { Market as OBMkt } from '@openbook-dex/openbook-v2';
import { getPool } from './raydium';
import { scanOne } from './scan';
import { buildBundle } from './arbTx';

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(require('fs').readFileSync(process.env.PRIVATE_KEY, 'utf-8')))
);
const conn = new Connection(process.env.RPC_URL, 'processed');

const OB_PROGRAM = new PublicKey('opnb2LAfJYbRMAHHvBJp4pR9u8P5gAGqJ7d6Fj9LqN6');
const RAY_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

async function run() {
  const obMarket = await OBMkt.load(conn, OB_PROGRAM, SOL, USDC); // SOL/USDC
  const rayPool = await getPool(conn, RAY_PROGRAM, SOL, USDC);

  for (;;) {
    const opp = await scanOne(conn, obMarket, rayPool, 1000);
    if (opp) {
      console.log('Found arb:', opp);
      const bundle = await buildBundle(opp, obMarket, rayPool, payer);
      const sig = await sendBundle(bundle); // Jito RPC
      console.log('Bundle landed:', sig);
    }
    await new Promise(r => setTimeout(r, 500)); // 2 polls / s
  }
}
run();
