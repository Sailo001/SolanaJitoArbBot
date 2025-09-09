import { Connection, PublicKey } from '@solana/web3.js';
import { Jupiter } from '@jup-ag/api';
import { OrcaPool } from '@orca-so/sdk';
import BN from 'bn.js';

const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

export async function scanArb(connection, tokens, amountSol = 0.1) {
  const jup  = new Jupiter(connection);
  const orca = new OrcaPool(connection);
  const amt  = new BN(amountSol * 1e9); // lamports
  const out  = [];

  for (const tok of tokens) {
    try {
      const mint = new PublicKey(tok.address);

      // Jupiter: SOL → TOKEN
      const jupRoute = await jup.quote({
        inputMint: SOL, outputMint: mint, amount: amt, slippageBps: 50
      });
      if (!jupRoute.data || !jupRoute.data.length) continue;
      const jupOut = new BN(jupRoute.data[0].outAmount);

      // Orca: TOKEN → SOL (reverse)
      const orcaPool = await orca.getPool(mint, SOL);
      const orcaOut  = await orcaPool.getOutputAmount(mint, jupOut);
      const orcaSol  = orcaOut.amount;

      const profit   = orcaSol.sub(amt);
      const profitPc = profit.muln(1000).div(amt).toNumber() / 10; // %
      if (profitPc < 0.1) continue;

      out.push({ symbol: tok.symbol, profitPc, profitSol: Number(profit) / 1e9 });
    } catch (e) { /* pool missing */ }
  }
  return out.sort((a, b) => b.profitPc - a.profitPc).slice(0, 3);
}
