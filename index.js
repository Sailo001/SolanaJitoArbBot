import http from 'http';
import fetch from 'node-fetch';

console.log("🚀 Starting Render Telegram Test App...");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID env variables!");
  process.exit(1);
}

console.log("BOT_TOKEN: ✅ Loaded");
console.log("CHAT_ID: ✅ Loaded");

// Send Telegram ping
async function sendTelegramMessage() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text: "✅ Render test successful! Your bot is alive 🎉",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log("📩 Telegram response:", data);
  } catch (err) {
    console.error("⚠️ Telegram send error:", err);
  }
}

// Send message when container starts
sendTelegramMessage();

// Healthcheck server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Telegram test bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌍 Healthcheck server listening on port ${PORT}`);
});
