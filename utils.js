// utils.js
export function isValidMintAddress(mint) {
  return /^[1-9A-HJ-NP-Za-km-z]{44}$/.test(mint); // Basic Base58 check
}

export function isValidDex(dex, supportedDexes = ['Orca', 'Raydium', 'Jupiter']) {
  return supportedDexes.includes(dex);
}
