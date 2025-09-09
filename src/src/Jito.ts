import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { bundleAndSend, flashLoan, repayFlashLoan } from 'jito-ts';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

export function flashLoanIx(mint: PublicKey, amount: number): TransactionInstruction {
  return flashLoan({ mint, amount: BigInt(amount) });
}

export function repayFlashLoanIx(mint: PublicKey): TransactionInstruction {
  return repayFlashLoan({ mint });
}

export async function sendBundle(tx: VersionedTransaction): Promise<string> {
  const { bundleId } = await bundleAndSend([tx]);
  return bundleId;
}
