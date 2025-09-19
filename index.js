// === Minimal Render Test App ===

// Log uncaught errors so Render doesn’t silently kill it
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, p) => {
  console.error("❌ Unhandled Rejection at:", p, "reason:", reason);
});

console.log("🚀 Starting Render Test App...");

// Check env vars
console.log("BOT_TOKEN:", process.env.BOT_TOKEN ? "✅ Loaded" : "❌ Missing");
console.log("CHAT_ID:", process.env.CHAT_ID ? "✅ Loaded" : "❌ Missing");

import http from "http";
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Render test app is running!\n");
  })
  .listen(PORT, () => {
    console.log(`🌍 Healthcheck server listening on port ${PORT}`);
  });
