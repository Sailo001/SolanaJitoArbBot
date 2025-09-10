use anchor_lang::prelude::*;

declare_id!("FLASHRcvr1111111111111111111111111111111111");

#[program]
pub mod flash_receiver {
    use super::*;
    pub fn execute_flash_arbitrage(ctx: Context<ExecuteFlash>, _bump: u8) -> Result<()> {
        msg!("flash_receiver: invoked - placeholder");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ExecuteFlash<'info> {
    #[account(mut)]
    pub user_account: Signer<'info>,
    pub system_program: Program<'info, System>,
}
