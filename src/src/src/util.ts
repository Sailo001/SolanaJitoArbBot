import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';

export const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PRIVATE_KEY!, 'utf-8'))),
);

export const connection = new Connection(process.env.RPC_URL!, {
  commitment: 'processed',
  wsEndpoint: process.env.WS_URL,
});

export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const SOL = new PublicKey('So11111111111111111111111111111111111111112');

export const OB_PROGRAM = new PublicKey('opnb2LAfJYbRMAHHvBJp4pR9u8P5gAGqJ7d6Fj9LqN6');
export const RAY_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
