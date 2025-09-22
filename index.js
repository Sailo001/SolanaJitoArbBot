import fetch from 'node-fetch';

const JUPITER_API = 'https://quote-api.jup.ag/v1/quote';
const TOKEN_LIST_API = 'https://token-list.jup.ag/';
const FLASH_BPS = 10; // example flash loan fee basis points
const TX_FEE = 0.000005; // example tx fee SOL
const JITO_TIP = 0.000005; // example tip SOL
const SIZE_USD = 100; // example trade size in USD

// Fetch token decimals from Jupiter token list
async function getDec(mint) {
  try {
    const res = await fetch(TOKEN_LIST_API);
    const data = await res.json();
    const token = data.tokens.find((t) => t.address === mint);
    if (!token) {
      console.warn(`Token not found in list: ${mint}`);
      return null;
    }
    return token.decimals;
  } catch (err) {
    console.error('Error fetching token list:', err);
    return null;
  }
}

// Query Jupiter API for routes and quotes
async function jupQuote(inputMint, outputMint, amount) {
  try {
    const url = `${JUPITER_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&onlyDirectRoutes=false&useUniswap=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Jupiter API error:', res.statusText);
      return null;
    }
    const data = await res.json();
    if (!data || !data.data) return null;
    return data;
  } catch (err) {
    console.error('Error fetching Jupiter quote:', err);
    return null;
  }
}

// Improved build function to find best arbitrage routes
async function build(mint, usd = SIZE_USD) {
  const dec = await getDec(mint);
  if (!dec) return [];

  // USDC and SOL mint addresses on Solana
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  // 1. Get all token -> USDC routes
  const sellQ = await jupQuote(mint, USDC_MINT, Math.floor(usd * 10 ** dec));
  if (!sellQ || !sellQ.data?.length) return [];

  // 2. Get all USDC -> SOL routes
  const buySolQ = await jupQuote(USDC_MINT, SOL_MINT, Math.floor(usd * 1e6));
  if (!buySolQ || !buySolQ.data?.length) return [];

  let bestRoute = null;
  let bestProfit = -Infinity;

  for (const sellRoute of sellQ.data) {
    // Compute USD per token from sell route output
    const usdReceived = Number(sellRoute.outAmount) / 1e6; // USDC has 6 decimals
    const tokenInputAmount = usd * 10 ** dec;
    const tokenAmount = tokenInputAmount / 10 ** dec;

    const usdPerToken = usdReceived / tokenAmount; // USD/token

    for (const buyRoute of buySolQ.data) {
      const solBack = Number(buyRoute.outAmount) / 1e9; // SOL has 9 decimals

      // Calculate profit estimation in USD terms
      const flashFee = (usd * FLASH_BPS) / 10000; // flash loan fee in USD
      // Convert SOL back to USD via usdPerToken for estimation
      // Here assuming 1 SOL ~ usdPerToken * tokenAmount; but this is just an approximation
      // For simplicity, consider solBack * current SOL price (could be fetched separately)
      // But here we just compare solBack * usdPerToken to USD input.

      // For demo, we just calculate profit = solBack * usdPerToken - usd - fees
      const profit = solBack * usdPerToken - usd - flashFee - (TX_FEE * 3) - JITO_TIP;

      if (profit > bestProfit) {
        bestProfit = profit;
        bestRoute = {
          buyDex: buyRoute.routePlan[0]?.swapInfo?.label ?? 'Unknown',
          sellDex: sellRoute.routePlan[0]?.swapInfo?.label ?? 'Unknown',
          profit,
          buySolRoute: buyRoute,
          sellTokenRoute: sellRoute,
          size: usd,
        };
      }
    }
  }

  if (!bestRoute || bestProfit <= 0) return [];

  return [bestRoute];
}

// Example usage - test with a token mint (e.g., Raydium RAY token mint)
async function test() {
  const RAY_MINT = '4k3Dyjzvzp8e7Jt4am6k7ZbWqT8Qwz1wZSYF5Qh5F8w4'; // Example token mint
  console.log('Fetching best arbitrage route...');
  const results = await build(RAY_MINT, SIZE_USD);
  if (results.length === 0) {
    console.log('No profitable arbitrage routes found.');
  } else {
    console.log('Best arbitrage route found:');
    console.log(JSON.stringify(results[0], null, 2));
  }
}

test();
