// index.js
import fetch from "node-fetch";
import express from "express";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 10000;

const ARB_THRESHOLD = 5; // % profit threshold

// === Healthcheck server (for Render) ===
const app = express();
app.get("/", (_, res) => res.send("Arbitrage bot is running ✅"));
app.listen(PORT, () =>
  console.log(`🌍 Healthcheck server listening on port ${PORT}`)
);

// === Utility: send Telegram alerts ===
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("⚠️ Telegram not configured. Skipping alert.");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
  }
}

// === Arbitrage Detection Pipeline ===
async function runPipeline() {
  console.log("🔄 Running arbitrage pipeline...");

  try {
    // Dexscreener all-pairs endpoint
    const url = "https://api.dexscreener.com/latest/dex/pairs";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Dexscreener error: ${res.status}`);
    const data = await res.json();

    if (!data.pairs) {
      console.log("⚠️ No pairs found");
      return;
    }

    // Group pools by token address
    const grouped = {};
    for (const pair of data.pairs) {
      const token = pair.baseToken?.address;
      if (!token) continue;

      if (!grouped[token]) grouped[token] = [];
      grouped[token].push({
        dex: pair.dexId,
        chain: pair.chainId,
        price: parseFloat(pair.priceUsd),
        url: pair.url,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name
      });
    }

    let found = 0;

    // Scan for arbitrage
    for (const token in grouped) {
      const pools = grouped[token];
      if (pools.length < 2) continue; // need at least 2 markets

      const prices = pools.map((p) => p.price).filter((p) => p > 0);
      if (prices.length < 2) continue;

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const spread = ((max - min) / min) * 100;

      if (spread >= ARB_THRESHOLD) {
        found++;

        const cheap = pools.find((p) => p.price === min);
        const expensive = pools.find((p) => p.price === max);

        const message = `
💰 *Arbitrage Opportunity Detected!*
Token: *${cheap.name || "Unknown"} (${cheap.symbol || "?"})*
Address: \`${token}\`

Buy on *${cheap.dex} (${cheap.chain})* @ $${min.toFixed(6)}
Sell on *${expensive.dex} (${expensive.chain})* @ $${max.toFixed(6)}

Spread: *${spread.toFixed(2)}%*

[Cheap Pool](${cheap.url})
[Expensive Pool](${expensive.url})
        `;

        console.log(message);
        await sendTelegramMessage(message);
      }
    }

    console.log(`✅ Checked ${Object.keys(grouped).length} tokens, found ${found} opportunities.`);
  } catch (err) {
    console.error("❌ Pipeline error:", err.message);
  }
}

// === Scheduler ===
// Run every 60s (adjustable)
setInterval(runPipeline, 60_000);
runPipeline();
