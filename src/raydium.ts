import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

// minimal Raydium AMM math (constant-product)
export interface Pool {
  getAmountOut(amountIn: number, mintIn: PublicKey, mintOut: PublicKey): { out: number; fee: number };
}

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

export async function getPool(
  conn: Connection,
  _programId: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
): Promise<Pool> {
  // 1. fetch all AMM v4 accounts (simple gPA)
  const filters = [
    { memcmp: { offset: 400, bytes: mintA.toBase58() } },
    { memcmp: { offset: 432, bytes: mintB.toBase58() } },
  ];
  const resp = await conn.getProgramAccounts(RAYDIUM_AMM_V4, { filters, dataSlice: { offset: 0, length: 1 } });
  if (resp.length === 0) throw new Error('Raydium pool not found');

  // 2. load full account
  const amm = await conn.getAccountInfo(resp[0].pubkey);
  if (!amm || !amm.data) throw new Error('Pool data empty');

  // 3. decode minimal fields (offset bytes from AMM v4 layout)
  const data = amm.data;
  const coinDecimals = data[400 + 63];
  const pcDecimals = data[432 + 63];
  const swapFee = data[1072]; // basis points
  const coinAmount = new BN(data.slice(400 + 64, 400 + 64 + 8), 'le');
  const pcAmount = new BN(data.slice(432 + 64, 432 + 64 + 8), 'le');

  // 4. return calculator
  return {
    getAmountOut(amountIn: number, mintIn: PublicKey): { out: number; fee: number } {
      const inAmt = new BN(Math.floor(amountIn * 1e9));
      const inRes = mintIn.equals(mintA) ? coinAmount : pcAmount;
      const outRes = mintIn.equals(mintA) ? pcAmount : coinAmount;
      const feeBp = swapFee;
      const inAmtLessFee = inAmt.mul(new BN(10000 - feeBp)).div(new BN(10000));
      const numerator = inAmtLessFee.mul(outRes);
      const denominator = inRes.add(inAmtLessFee);
      const out = numerator.div(denominator);
      return { out: Number(out) / 1e9, fee: Number(inAmt.sub(inAmtLessFee)) / 1e9 };
    },
  };
}
