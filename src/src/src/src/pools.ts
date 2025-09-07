import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from './config';

const ORCA_SOL_USDC = new PublicKey('7qbRF6YsyGuLUVs6Y1q64bdBlrV4zB8p8tMb2dB25amq');
const RAYDIUM_SOL_USDC = new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');

export async function fetchOrcaAmounts(connection: Connection, mintIn: PublicKey, amountIn: bigint) {
  // simplified: return constant product quote
  return amountIn; // TODO: use Orca SDK
}

export async function fetchRaydiumAmounts(connection: Connection, mintIn: PublicKey, amountIn: bigint) {
  return amountIn; // TODO: use Raydium SDK
}
