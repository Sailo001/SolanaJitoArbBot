// === index.js ===
import 'dotenv/config';
import express from "express";
import fetch from "node-fetch";

// === Telegram Config ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// === Express Server (health + webhook) ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🚀 Meme Coin Awakener bot is live!");
});

app.post("/webhook", express.json(), (req, res) => {
  console.log("📩 Telegram update:", req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// === Telegram send helper ===
async function sendTelegram(msg) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg }),
    });
    if (!res.ok) console.error("❌ Telegram error:", await res.text());
  } catch (e) {
    console.error("❌ Telegram send failed:", e);
  }
}

// === Fetch Meme Coins from Dexscreener ===
async function fetchFromDexscreener() {
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana&page=1");
    if (!res.ok) throw new Error("Dexscreener API failed");
    const data = await res.json();
    return data.pairs || [];
  } catch (err) {
    console.warn("⚠️ Dexscreener failed:", err.message);
    return [];
  }
}

// === Fetch Meme Coins from Jupiter ===
async function fetchFromJupiter() {
  try {
    const res = await fetch("https://token.jup.ag/all");
    if (!res.ok) throw new Error("Jupiter API failed");
    const data = await res.json();
    return data.filter(
      (t) =>
        /inu|doge|shib|cat|moon|pepe|baby|meme/i.test(t.symbol || "") ||
        /inu|doge|shib|cat|moon|pepe|baby|meme/i.test(t.name || "")
    );
  } catch (err) {
    console.warn("⚠️ Jupiter fallback failed:", err.message);
    return [];
  }
}

// === Merge + Deduplicate ===
function mergeTokens(dexTokens, jupTokens) {
  const seen = new Set();
  const merged = [];

  [...dexTokens, ...jupTokens].forEach((t) => {
    const addr = t.address || t.baseToken?.address;
    if (!addr || seen.has(addr)) return;
    seen.add(addr);
    merged.push(t);
  });

  return merged;
}

// === Main Pipeline ===
async function runPipeline() {
  console.log("🔄 Running pipeline...");

  const dexTokens = await fetchFromDexscreener();
  const jupTokens = await fetchFromJupiter();

  const tokens = mergeTokens(dexTokens, jupTokens);

  if (tokens.length === 0) {
    console.log("🪙 Found 0 meme coins");
    await sendTelegram("⚠️ No meme coins detected this round.");
    return;
  }

  console.log(`🪙 Found ${tokens.length} meme coins`);
  let msg = `🪙 Found ${tokens.length} meme coins\n`;

  tokens.slice(0, 5).forEach((t, i) => {
    msg += `#${i + 1} ${t.name || "Unknown"} (${t.symbol || "?"}) - Address: ${
      t.address || t.baseToken?.address || "N/A"
    }\n`;
  });

  console.log(msg);
  await sendTelegram(msg);
}

// Run pipeline every 30s
setInterval(runPipeline, 30000);

// Kick off first run immediately
runPipeline();
