// src/scan.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { Market as OBMkt, Orderbook } from '@openbook-dex/openbook-v2';
import { Pool as RayPool, getPool } from './raydium'; // tiny wrapper
import { matchOrder } from './clobMath';

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

export async function scanOne(
  conn: Connection,
  obMarket: OBMkt,
  rayPool: RayPool,
  usdcAmount: number, // 1 000 USDC
) {
  // 1. CLOB side: USDC → SOL
  const book = await obMarket.loadOrderbook(conn);
  const baseLots = new BN(Math.floor(usdcAmount / obMarket.quoteLotSize.toNumber()));
  const [obPrice, rem] = matchOrder(book, 'buy', baseLots, new BN(999999999));
  if (rem.gt(new BN(0))) return null; // not enough liquidity
  const solReceived = usdcAmount / obPrice; // gross

  // 2. AMM side: SOL → USDC (Raydium)
  const { out: usdcBack, fee } = rayPool.getAmountOut(solReceived, SOL, USDC);

  // 3. Net
  const profit = usdcBack - usdcAmount - fee;
  const profitPc = (profit / usdcAmount) * 100;
  return profitPc > 0.15 ? { obPrice, solReceived, usdcBack, profitPc } : null;
}
