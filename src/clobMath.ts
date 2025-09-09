import { BN } from 'bn.js';

// --- Open-book v2 order-book leaf -------------------------------------------------
export interface Order {
  price: BN; // quote-lots per base-lot
  size: BN; // base-lots
}

// --- Lightweight order-book view -------------------------------------------------
export interface Orderbook {
  bids: Order[]; // descending price
  asks: Order[]; // ascending price
}

/**
 * Walk the order-book and compute the average fill price for a market order.
 * Returns [averagePrice, remainingSize]  (price is in quote-lots per base-lot).
 * If remainingSize > 0 the book is too shallow.
 */
export function matchOrder(
  book: Orderbook,
  side: 'buy' | 'sell',
  size: BN,       // base-lots wanted
  limitPrice: BN, // worst price you accept (quote-lots per base-lot)
): [number, BN] {
  const orders = side === 'buy' ? book.asks : book.bids;
  let rem = size;
  let quoteSum = new BN(0);

  for (const o of orders) {
    // price filter
    if (side === 'buy'  && o.price.gt(limitPrice)) break;
    if (side === 'sell' && o.price.lt(limitPrice)) break;

    const take = BN.min(rem, o.size);
    rem = rem.sub(take);
    quoteSum = quoteSum.add(take.mul(o.price));
    if (rem.isZero()) break;
  }

  const filled = size.sub(rem);
  const avgPrice = filled.isZero() ? 0 : quoteSum.toNumber() / filled.toNumber();
  return [avgPrice, rem];
}
