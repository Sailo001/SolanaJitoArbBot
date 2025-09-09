import { Connection, PublicKey } from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeys,
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
  parseBigNumberish,
} from '@raydium-io/raydium-sdk';

export interface Pool {
  getAmountOut(amountIn: number, mintIn: PublicKey, mintOut: PublicKey): {
    out: number;
    fee: number;
  };
}

export async function getPool(
  conn: Connection,
  programId: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
): Promise<Pool> {
  // 1. fetch all AmmV4 pools (official SDK helper)
  const all = await Liquidity.fetchAllPoolKeys(conn, { programId });
  const keys = all.find(
    (k) =>
      (k.baseMint.equals(mintA) && k.quoteMint.equals(mintB)) ||
      (k.baseMint.equals(mintB) && k.quoteMint.equals(mintA)),
  );
  if (!keys) throw new Error('Raydium pool not found');

  // 2. load pool info
  const info = await Liquidity.fetchInfo({ connection: conn, poolKeys: keys });

  // 3. return calculator
  return {
    getAmountOut(amountIn: number, mintIn: PublicKey): { out: number; fee: number } {
      const zero = new TokenAmount(Token.WSOL, 0);
      const taIn = new TokenAmount(
        new Token(mintIn, 6, 'TEMP', 'temp'),
        parseBigNumberish(Math.floor(amountIn * 1e9)),
      );
      const { amountOut, fee } = Liquidity.computeAmountOut({
        poolKeys: keys,
        poolInfo: info,
        amountIn: taIn,
        currencyOut: mintIn.equals(keys.baseMint) ? keys.quoteMint : keys.baseMint,
        slippage: 0, // off-chain calc
      });
      return { out: Number(amountOut.raw) / 1e9, fee: Number(fee.raw) / 1e9 };
    },
  };
        }
