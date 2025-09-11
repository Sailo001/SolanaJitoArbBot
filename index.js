// index.js
// === Solana Arbitrage Detector + Telegram Alerts ===

import 'dotenv/config';
import fetch from 'node-fetch';
import { createServer } from 'http';

// === ENV VARS ===
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Raydium API endpoints
const RAYDIUM_POOLS = "https://api.raydium.io/v2/main/pairs";

// === Telegram Notify ===
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

// === Arbitrage Scanner ===
async function checkArbitrage() {
  try {
    console.log("🔍 Fetching Raydium pools...");
    const res = await fetch(RAYDIUM_POOLS);
    const pools = await res.json();

    // Slice into manageable chunks to avoid crashes
    const chunk = pools.slice(0, 100); // scan only first 100 pools
    let opportunities = [];

    for (let i = 0; i < chunk.length; i++) {
      for (let j = i + 1; j < chunk.length; j++) {
        const poolA = chunk[i];
        const poolB = chunk[j];

        // Ensure they trade the same pair
        if (
          poolA.baseMint === poolB.baseMint &&
          poolA.quoteMint === poolB.quoteMint
        ) {
          const priceA = parseFloat(poolA.price);
          const priceB = parseFloat(poolB.price);

          if (!priceA || !priceB) continue;

          const diff = Math.abs(priceA - priceB);
          const avg = (priceA + priceB) / 2;
          const spread = (diff / avg) * 100;

          if (spread >= 5) {
            opportunities.push({
              token: poolA.baseSymbol,
              pool1: poolA.marketId,
              pool2: poolB.marketId,
              spread: spread.toFixed(2),
              priceA,
              priceB,
            });
          }
        }
      }
    }

    if (opportunities.length > 0) {
      for (const opp of opportunities) {
        await sendTelegram(
          `🔔 *Arbitrage Opportunity Found!*\n\n` +
          `Token: ${opp.token}\n` +
          `Spread: *${opp.spread}%*\n` +
          `Pool A Price: ${opp.priceA}\n` +
          `Pool B Price: ${opp.priceB}\n` +
          `Pool1: \`${opp.pool1}\`\nPool2: \`${opp.pool2}\``
        );
      }
    } else {
      console.log("No opportunities this round.");
    }
  } catch (err) {
    console.error("Arbitrage error:", err);
  }
}

// === Run every 60s ===
setInterval(checkArbitrage, 60 * 1000);

// === Minimal health server for Render ===
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✅ Server running on http://${HOST}:${PORT}`);
});
