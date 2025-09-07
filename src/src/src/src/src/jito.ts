import { Bundle } from '@jito-foundation/jito-ts';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { CONFIG } from './config';

const connection = new Connection(CONFIG.rpc);
const keypair = Keypair.fromSecretKey(CONFIG.privateKey);

export async function sendBundle(txs: VersionedTransaction[], tipLamports: number): Promise<string> {
  const bundle = new Bundle();
  txs.forEach(tx => bundle.addTransactions(tx));
  bundle.addTipTx(tipLamports, keypair.publicKey);
  const resp = await bundle.send(connection);
  return resp;
}
