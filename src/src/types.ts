export interface ArbOpportunity {
  mintA: string;
  mintB: string;
  leg1Market: 'orca' | 'raydium';
  leg1InAmount: bigint;
  leg1OutAmount: bigint;
  leg2Market: 'jupiter';
  leg2OutAmount: bigint;
  profitSol: number;
}
