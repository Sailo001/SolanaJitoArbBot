import { Connection, PublicKey } from '@solana/web3.js';
import { Market as OBMarket, Orderbook } from '@openbook-dex/openbook-v2';

export { Orderbook }; // re-export for rest of app

export class Market {
  constructor(
    public market: OBMarket,
    public asks: Orderbook,
    public bids: Orderbook,
    public quoteLotSize: BN,
  ) {}

  static async load(
    conn: Connection,
    programId: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
  ): Promise<Market> {
    const marketAccount = await OBMarket.load(conn, programId, baseMint, quoteMint);
    const [asksAcc, bidsAcc] = await Promise.all([
      conn.getAccountInfo(marketAccount.asks),
      conn.getAccountInfo(marketAccount.bids),
    ]);
    if (!asksAcc || !bidsAcc) throw new Error('Orderbook accounts missing');
    const asks = Orderbook.decode(marketAccount, asksAcc.data);
    const bids = Orderbook.decode(marketAccount, bidsAcc.data);
    return new this(marketAccount, asks, bids, marketAccount.quoteLotSize);
  }

  loadOrderbook(conn: Connection): Promise<Orderbook> {
    // refresh
    return Market.load(conn, this.market.programId, this.market.baseMint, this.market.quoteMint).then(
      (m) => m.bids.concat(m.asks), // dummy concat for convenience
    );
  }

  makePlaceOrderIx(params: any) {
    return this.market.makePlaceOrderTx(params).ixs[0]; // SDK returns full tx
  }
}
