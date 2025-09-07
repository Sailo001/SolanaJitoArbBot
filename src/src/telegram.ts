import TelegramBot from 'node-telegram-bot-api';
import { CONFIG } from './config';
import { register } from 'prom-client';

export const tg = new TelegramBot(CONFIG.tgToken, { polling: true });

tg.onText(/\/start/, msg => {
  tg.sendMessage(msg.chat.id, '🤖 Solana-Jito arb bot alive\n💰 PnL: 0 SOL');
});

tg.onText(/\/status/, async msg => {
  const metrics = await register.getMetricsAsJSON();
  const bundles = metrics.find(m => m.name === 'bundles_sent')?.values[0].value || 0;
  const pnl = metrics.find(m => m.name === 'realised_pnl_sol')?.values[0].value || 0;
  tg.sendMessage(msg.chat.id, `📊 bundles: ${bundles}\n💰 PnL: ${pnl.toFixed(4)} SOL`);
});
