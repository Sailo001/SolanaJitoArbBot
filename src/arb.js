import { Connection, PublicKey } from '@solana/web3.js';
import { Jupiter } from '@jup-ag/api';
import BN from 'bn.js';

const SOL = new PublicKey('So11111111111111111111111111111111111111112');

export async function scanArb(connection, tokens, amountSol = 0.1) {
  const jup = new Jupiter(connection);
  const amt = new BN(amountSol * 1e9);
  const out = [];

  for (const tok of tokens) {
    try {
      const mint = new PublicKey(tok.address);

      // Jupiter route 1: SOL → TOKEN
      const route1 = await jup.quote({
        inputMint: SOL, outputMint: mint, amount: amt, slippageBps: 50
      });
      if (!route1.data || !route1.data.length) continue;
      const tokenOut = new BN(route1.data[0].outAmount);

      // Jupiter route 2: TOKEN → SOL (reverse)
      const route2 = await jup.quote({
        inputMint: mint, outputMint: SOL, amount: tokenOut, slippageBps: 50
      });
      if (!route2.data || !route2.data.length) continue;
      const solBack = new BN(route2.data[0].outAmount);

      const profit = solBack.sub(amt);
      const profitPc = profit.muln(1000).div(amt).toNumber() / 10;
      if (profitPc < 0.1) continue;

      out.push({ symbol: tok.symbol, profitPc, profitSol: Number(profit) / 1e9 });
    } catch (e) { /* no route */ }
  }
  return out.sort((a, b) => b.profitPc - a.profitPc).slice(0, 3);
}
