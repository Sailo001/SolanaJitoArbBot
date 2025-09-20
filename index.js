// index.js
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// DEX endpoints (replace with real ones if you have)
const RAYDIUM_URL = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const ORCA_URL = "https://api.orca.so/allPools";
const LIFINITY_URL = "https://api.lifinity.io/pools";

// Fallback: Solana Token List
const SOLANA_TOKEN_LIST = "https://tokens.solana.com/tokens.json";

// --- Helpers ---
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram not configured, skipping alert.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("⚠️ Failed to send Telegram alert:", err.message);
  }
}

async function fetchFromDEX(name, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name} API returned ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`⚠️ ${name} API failed, switching to fallback logs: ${err.message}`);
    return []; // prevent crash
  }
}

function filterMemeCoins(tokens) {
  return tokens.filter(t => {
    const name = (t.name || "").toLowerCase();
    return /doge|shiba|pepe|inu|cat|meme|moon|elon|wojak/i.test(name);
  });
}

// --- Pipeline ---
async function runPipeline() {
  console.log("🔄 Running pipeline...");

  // Try DEX APIs
  const raydium = await fetchFromDEX("Raydium", RAYDIUM_URL);
  const orca = await fetchFromDEX("Orca", ORCA_URL);
  const lifinity = await fetchFromDEX("Lifinity", LIFINITY_URL);

  let combined = [];
  try {
    combined = [
      ...(raydium?.official ?? []),
      ...(orca?.pools ?? []),
      ...(lifinity?.pools ?? [])
    ];
  } catch {
    combined = [];
  }

  let memeCoins = [];
  if (combined.length > 0) {
    memeCoins = filterMemeCoins(combined.map(p => ({
      name: p.name || p.symbol || "",
      address: p.address || p.mint || ""
    })));
  }

  // If DEXs fail → fallback
  if (memeCoins.length === 0) {
    console.warn("⚠️ All DEX APIs failed. Falling back to Solana Token List...");
    try {
      const res = await fetch(SOLANA_TOKEN_LIST);
      const tokens = await res.json();
      memeCoins = filterMemeCoins(tokens);
    } catch (err) {
      console.error("❌ Fallback also failed:", err.message);
    }
  }

  if (memeCoins.length > 0) {
    console.log(`🪙 Found ${memeCoins.length} meme coins`);
    memeCoins.slice(0, 5).forEach((c, i) => {
      console.log(`#${i + 1} ${c.name} - Address: ${c.address}`);
    });

    await sendTelegramAlert(
      `🚨 Found ${memeCoins.length} meme coins!\n\nTop 3:\n` +
      memeCoins.slice(0, 3).map((c, i) =>
        `#${i + 1} *${c.name}*\n\`${c.address}\``
      ).join("\n\n")
    );
  } else {
    console.log("❌ No meme coins found this cycle.");
  }
}

// --- Scheduler ---
setInterval(runPipeline, 30000); // every 30s
runPipeline(); // run immediately

// --- Healthcheck server ---
const app = express();
app.get("/", (_, res) => res.send("🤖 Meme coin arbitrage bot running!"));
app.listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});
