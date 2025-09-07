import express from 'express';
import { register } from 'prom-client';
import { CONFIG } from './config';
import { startArbEngine } from './arb';
import { initTelegram } from './telegram';

const app = express();
app.get('/', (_req, res) => res.json({ status: 'ok', slot: global.slot || 0 }));
app.get('/metrics', (_req, res) => res.set('Content-Type', register.contentType).end(register.metrics()));

app.listen(CONFIG.port, () => {
  console.log(`[express] listening on :${CONFIG.port}`);
});

initTelegram();
startArbEngine();
