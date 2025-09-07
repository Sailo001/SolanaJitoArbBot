import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { CONFIG } from './config';
import { fetchOrcaAmounts, fetchRaydiumAmounts } from './pools';
import { jupiterQuoteExactOut } from './jupiter';
import { sendBundle } from './jito';
import { Counter, Gauge } from 'prom-client';
import { tg } from './telegram';

const connection = new Connection(CONFIG.rpc);
const bundlesSent = new Counter({ name: 'bundles_sent', help: 'Total bundles landed' });
const pnlGauge = new Gauge({ name: 'realised_pnl_sol', help: 'SOL profit' });

export function startArbEngine() {
  setInterval(async () => {
    try {
      global.slot = await connection.getSlot();
      const opps = await findOpportunities();
      for (const opp of opps) {
        if (opp.profitSol < CONFIG.minProfitSol) continue;
        const txs = await buildBundleTxs(opp);
        const bundleId = await sendBundle(txs, CONFIG.jitoTipLamports);
        bundlesSent.inc();
        pnlGauge.inc(opp.profitSol);
        tg.sendMessage(CONFIG.tgChatId, `✅ bundle landed ${bundleId} +${opp.profitSol.toFixed(4)} SOL`);
      }
    } catch (e) {
      console.error('arb loop error', e);
    }
  }, 500);
}

async function findOpportunities() {
  const mintA = 'So11111111111111111111111111111111111111112'; // SOL
  const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
  const inAmount = BigInt(1_000_000_000); // 1 SOL

  const outOrca = await fetchOrcaAmounts(connection, new PublicKey(mintA), inAmount);
  const outRaydium = await fetchRaydiumAmounts(connection, new PublicKey(mintA), inAmount);
  const bestOut = outOrca > outRaydium ? outOrca : outRaydium;
  const leg1Market = outOrca > outRaydium ? 'orca' : 'raydium';

  const jup = await jupiterQuoteExactOut(mintB, mintA, bestOut);
  const profit = Number(jup.amountIn - inAmount) / 1e9; // rough
  if (profit <= 0) return [];

  return [{
    mintA, mintB, leg1Market, leg1InAmount: inAmount, leg1OutAmount: bestOut,
    leg2Market: 'jupiter', leg2OutAmount: jup.amountIn, profitSol: profit
  }];
}

async function buildBundleTxs(opp: any): Promise<VersionedTransaction[]> {
  // build VersionedTransaction[] – placeholder
  const msg = new VersionedTransaction(new Uint8Array(1)); // TODO
  return [msg];
  }
