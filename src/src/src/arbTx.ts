// src/arbTx.ts
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { bundleTxs } from 'jito-ts';

export async function buildBundle(
  opportunity: any,
  obMarket: OBMkt,
  rayPool: RayPool,
  payer: Keypair,
): Promise<VersionedTransaction> {
  const tx = new Transaction();

  // 1. Jito flash-loan 1 000 USDC → temp vault
  tx.add(flashLoanIx(1000_000000, USDC)); // 6 decimals

  // 2. OpenBook: spend 1 000 USDC → buy SOL
  tx.add(obMarket.makePlaceOrderIx({
    side: 'buy',
    price: opportunity.obPrice,
    size: opportunity.solReceived,
    payer: vaultUSDC,
  }));

  // 3. Raydium: swap SOL → USDC
  tx.add(rayPool.swapIx(solReceived, SOL, USDC, vaultUSDC));

  // 4. Repay flash-loan (Jito auto-verifies balance)
  tx.add(repayFlashLoanIx(USDC));

  return bundleTxs([tx], payer);
}
