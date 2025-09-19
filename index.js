// index.js
import fetch from "node-fetch";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD || "0.5");
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "20000"); // 20s
const QUOTE_TOKEN = process.env.QUOTE_TOKEN || "USDC";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50"); // tokens per scan
const TOKEN_AGE_HOURS = parseInt(process.env.TOKEN_AGE_HOURS || "48"); // last 48h

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in environment variables");
  process.exit(1);
}

// ===== Telegram sender =====
async function sendTelegramMessage(msg) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg }),
    });
  } catch (err) {
    console.error("⚠️ Telegram send error:", err.message);
  }
}

// ===== Load Solana Token List =====
let seenTokens = new Set();
let allTokens = [];

async function loadTokens() {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json"
    );
    const data = await res.json();
    allTokens = data.tokens.filter(
      (t) =>
        t.symbol !== QUOTE_TOKEN &&
        t.chainId === 101 &&
        t.decimals <= 9
    );
    console.log(`✅ Loaded ${allTokens.length} tokens from Solana Token List`);
  } catch (err) {
    console.error("⚠️ Solana Token List fetch error:", err.message);
  }
}

// ===== Fetch DEX prices from Jupiter =====
async function getDexPrices(inputMint, outputMint) {
  try {
    const url =
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      "&amount=1000000&onlyDirectRoutes=true";
    const res = await fetch(url);
    const data = await res.json();

    const prices = {};
    if (data.data) {
      data.data.forEach((route) => {
        const dex = route.marketInfos[0]?.amm.label;
        const outAmount = parseFloat(route.outAmount) / 1e6;
        if (dex) {
          if (!prices[dex] || outAmount > prices[dex]) prices[dex] = outAmount;
        }
      });
    }
    return prices;
  } catch (err) {
    console.error("⚠️ Jupiter quote fetch error", err.message);
    return {};
  }
}

// ===== Get number of DEXs with liquidity =====
async function getTokenLiquidity(tokenAddress) {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&onlyDirectRoutes=true`;
    const res = await fetch(url);
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    return [];
  }
}

// ===== Prioritized token batch =====
async function getNewTokensBatchPrioritized() {
  const cutoff = Date.now() - TOKEN_AGE_HOURS * 3600 * 1000;
  const newTokens = allTokens.filter(
    (t) =>
      !seenTokens.has(t.address) &&
      (!t.extensions.creationDate ||
        new Date(t.extensions.creationDate).getTime() >= cutoff)
  );

  const tokensWithLiquidity = await Promise.all(
    newTokens.map(async (t) => {
      const routes = await getTokenLiquidity(t.address);
      return { token: t, dexCount: routes.length };
    })
  );

  // Sort descending by DEX count
  tokensWithLiquidity.sort((a, b) => b.dexCount - a.dexCount);

  // Take top batch
  const batch = tokensWithLiquidity.slice(0, BATCH_SIZE).map((t) => t.token);
  batch.forEach((t) => seenTokens.add(t.address));
  return batch;
}

// ===== Real-time PnL tracking =====
const trackedOpportunities = new Map();

// ===== Arbitrage scanner =====
async function scanArbitrage() {
  const tokensBatch = await getNewTokensBatchPrioritized();
  if (tokensBatch.length === 0) return;

  for (const token of tokensBatch) {
    const prices = await getDexPrices(
      token.address,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
    );
    if (Object.keys(prices).length < 2) continue;

    const minDex = Object.keys(prices).reduce((a, b) =>
      prices[a] < prices[b] ? a : b
    );
    const maxDex = Object.keys(prices).reduce((a, b) =>
      prices[a] > prices[b] ? a : b
    );

    const spread = ((prices[maxDex] - prices[minDex]) / prices[minDex]) * 100;

    if (spread > SPREAD_THRESHOLD) {
      const key = token.address; // track per token
      const prev = trackedOpportunities.get(key);

      // Only notify if it's new or spread increased
      if (!prev || spread > prev.spread) {
        const msg =
          `🚨 Arbitrage detected!\n` +
          `Token: ${token.symbol}\n` +
          `${minDex} → ${maxDex}\n` +
          `Buy @ ${prices[minDex].toFixed(4)} | Sell @ ${prices[maxDex].toFixed(
            4
          )}\n` +
          `Spread: ${spread.toFixed(2)}% (Threshold: ${SPREAD_THRESHOLD}%)`;
        console.log(msg);
        await sendTelegramMessage(msg);

        // Track PnL for token
        trackedOpportunities.set(key, {
          token: token.symbol,
          buyDex: minDex,
          sellDex: maxDex,
          buyPrice: prices[minDex],
          sellPrice: prices[maxDex],
          spread,
          lastUpdated: Date.now(),
        });
      }
    }
  }
}

// Optional: Print current tracked PnL every interval
setInterval(() => {
  if (trackedOpportunities.size > 0) {
    console.log("📊 Current tracked arbitrage opportunities:");
    for (const [key, opp] of trackedOpportunities.entries()) {
      const profitPerUnit = opp.sellPrice - opp.buyPrice;
      console.log(
        `${opp.token}: Buy ${opp.buyDex} @${opp.buyPrice.toFixed(
          4
        )}, Sell ${opp.sellDex} @${opp.sellPrice.toFixed(
          4
        )}, Spread ${opp.spread.toFixed(
          2
        )}%, Profit per token ${profitPerUnit.toFixed(4)}`
      );
    }
  }
}, 30000); // log every 30s

// ===== Initialize =====
await loadTokens();
setInterval(scanArbitrage, SCAN_INTERVAL);

// ===== Healthcheck server =====
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ Arbitrage bot is running!\n");
  })
  .listen(PORT, () => {
    console.log(`🌍 Healthcheck server listening on port ${PORT}`);
  });

console.log("🤖 Meme coin arbitrage bot started...");
sendTelegramMessage(
  `✅ Bot deployed with prioritized meme coin arbitrage scanning + real-time PnL!\n` +
    `📈 Spread threshold: ${SPREAD_THRESHOLD}% | Scan interval: ${SCAN_INTERVAL}ms | Batch size: ${BATCH_SIZE}`
);
