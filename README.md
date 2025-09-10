# Solana Arbitrage Bot (ready-to-push)

This repo contains a lightweight Solana arbitrage Telegram bot with cross-DEX detection, atomic triangular execution (via Jupiter), adapters for Raydium/Orca/OpenBook, and a scaffolded Anchor flash-loan receiver.

**WARNING**: This repo is for developers. Test on Devnet. Do not run on Mainnet with real funds without auditing and thorough testing.

## Quick setup
1. Clone this repo.
2. Copy `.env.example` to `.env` and populate values.
3. `npm install` (or `npm ci`).
4. `node index.js` (or run inside Docker / Render).

## Files of interest
- `index.js` — main bot (NODE). Replace with care.
- `flash_client_example.js` — how the bot would call a deployed Anchor flash receiver.
- `programs/flash_receiver` — Anchor program scaffold (Rust).

## Env variables (.env)
See `.env.example`.

## Devnet recommendation
Set `RPC_URL=https://api.devnet.solana.com`, test with a throwaway key and small sizes.
