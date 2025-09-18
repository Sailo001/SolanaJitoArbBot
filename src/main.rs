use yellowstone_grpc_client::{GeyserClient, Interceptor};
use solana_sdk::pubkey::Pubkey;
use serde::Deserialize;
use std::str::FromStr;

const ORCA_WSOL_USDC: &str = "7qbRF6YsyGuLUVs6Y1q64bnFoQFrmGBp3obRDXU7X6J9"; // Orca wSOL/USDC pool
const RAYDIUM_WSOL_USDC: &str = "58oQChx4yWmvK6LfBM2H9GcUb9c4HW7cMc6x64q7ahfk"; // Raydium wSOL/USDC pool

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let helius_url = std::env::var("HELius_RPC").expect("HELius_RPC not set");
    let client = GeyserClient::connect(helius_url).await?;
    let orca = Pubkey::from_str(ORCA_WSOL_USDC).unwrap();
    let ray = Pubkey::from_str(RAYDIUM_WSOL_USDC).unwrap();

    let mut orca_stream = client.subscribe_account(orca, None).await?;
    let mut ray_stream  = client.subscribe_account(ray, None).await?;

    while let (Some(o), Some(r)) = tokio::join!(orca_stream.next(), ray_stream.next()) {
        let orca_price = parse_orca_price(&o.data);
        let ray_price  = parse_raydium_price(&r.data);
        let spread = (ray_price - orca_price) / orca_price;
        if spread.abs() > 0.008 {   // 0.8 % net
            log_arbitrage(orca_price, ray_price, spread).await?;
        }
    }
}

fn parse_orca_price(data: &[u8]) -> f64 {
    // Orca constant-product pool: price = sqrt(token_B / token_A)
    let (a, b) = extract_token_amounts(data); // your helper
    (b as f64 / a as f64).sqrt()
}

fn parse_raydium_price(data: &[u8]) -> f64 {
    // Raydium constant-product AMM: price = sqrt(token_B / token_A)
    let (a, b) = extract_token_amounts(data); // your helper
    (b as f64 / a as f64).sqrt()
}

async fn log_arbitrage(orca: f64, ray: f64, spread: f64) -> Result<(), Box<dyn std::error::Error>> {
    let msg = format!("Arb: Orca={:.6} Ray={:.6} Spread={:.2}%", orca, ray, spread * 100.0);
    logger::info("{}", msg);
    // Stage-2: we’ll post to Telegram here
    Ok(())
}
