import axios from 'axios';
import { CONFIG } from './config';

export async function jupiterQuoteExactOut(
  mintIn: string,
  mintOut: string,
  amountOut: bigint
): Promise<{ amountIn: bigint; tx: any }> {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${mintIn}&outputMint=${mintOut}&amount=${amountOut.toString()}&slippageBps=50&onlyDirectRoutes=true`;
  const { data } = await axios.get(url);
  return { amountIn: BigInt(data.inAmount), tx: data };
}
