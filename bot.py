    async def fetch_trending_solana_mints(self, session: aiohttp.ClientSession, needed: int = 300) -> dict:
        """
        Uses Raydium API v2 – returns *all* USDC-paired pools (1000+).
        Filters ≥ $2 k liquidity and validates mints.
        """
        url = "https://api.raydium.io/v2/ammV3/ammPools"   # official, no key
        try:
            async with session.get(url, timeout=15) as resp:
                if resp.status != 200:
                    logger.warning("Raydium API HTTP %s", resp.status)
                    return {}
                data = await resp.json()
                out = {}
                for pool in data.get("data", []):
                    if pool.get("quoteMint") != USDC_ADDRESS:
                        continue
                    liquidity = float(pool.get("liquidity", 0))
                    if liquidity < 2_000:          # ≥ $2 k  (lower if you want)
                        continue
                    mint = pool["baseMint"]
                    symbol = pool.get("symbol", "UNKNOWN")
                    try:
                        Pubkey.from_string(mint)
                        out[symbol] = {"address": mint}
                        if len(out) >= needed:
                            break
                    except Exception:
                        continue
                logger.info("Loaded %s Raydium pools (≥$2 k) from API v2", len(out))
                return out
        except Exception as e:
            logger.error("Raydium API v2 failed: %s", e)

        # ------------------------------------------------------------------
        # Ultimate fallback – DexScreener pages (kept for safety)
        # ------------------------------------------------------------------
        out, page = {}, 1
        while len(out) < min(needed, 100):
            url = f"https://api.dexscreener.com/latest/dex/search?q=solana&page={page}"
            try:
                async with session.get(url, timeout=15) as resp:
                    if resp.status != 200:
                        break
                    data = await resp.json()
                pairs = data.get("pairs", [])
                if not pairs:
                    break
                for pair in pairs:
                    mint = pair["baseToken"]["address"]
                    symbol = pair["baseToken"]["symbol"]
                    if mint.lower() in ("solana", "sol", ""):
                        continue
                    try:
                        Pubkey.from_string(mint)
                        out[symbol] = {"address": mint}
                        if len(out) >= needed:
                            return out
                    except Exception:
                        continue
                page += 1
            except Exception as e:
                logger.error("DexScreener page %s error: %s", page, e)
                break
        logger.info("Fetched %s valid Solana mints (fallback)", len(out))
        return out
