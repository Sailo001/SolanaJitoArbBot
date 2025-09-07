import { config } from 'dotenv';
config();

export const CONFIG = {
  rpc: process.env.SOLANA_RPC!,
  jitoAuthKey: process.env.JITO_AUTH_KEY!,
  privateKey: Uint8Array.from(Buffer.from(process.env.PRIVATE_KEY_B58!, 'base58')) as Buffer,
  tgToken: process.env.TG_BOT_TOKEN!,
  tgChatId: process.env.TG_CHAT_ID!,
  minProfitSol: parseFloat(process.env.MIN_PROFIT_SOL!),
  jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS!),
  port: parseInt(process.env.PORT!) || 8080,
} as const;
