import type { ReadonlyPairBook } from '../stream/core';

// The §7.3 P&L split, client half: realised comes from the server and moves
// only on trade events; unrealised is this multiplication against the hot
// mid and moves with every tick. Pushing it through GraphQL would drag hot
// tempo through the warm channel — the client already holds both inputs.

/** Reduces a book's top to a single mid, or null while a side is missing. */
interface MidCalculator {
  (book: ReadonlyPairBook | undefined): number | null;
}

/** Multiplies a position against a mid to get unrealised P&L. */
interface UnrealisedCalculator {
  (netQtyK: number, avgPx: number, mid: number): number;
}

/** Mid of a book's top, or null while either side is missing. */
export const midOf: MidCalculator = (book) => {
  const bid = book?.bids[0];
  const ask = book?.asks[0];
  if (bid == null || ask == null) return null;
  return (bid.price + ask.price) / 2;
};

/** Unrealised P&L in pipette·K units — same units as the server's realised. */
export const unrealisedPnl: UnrealisedCalculator = (netQtyK, avgPx, mid) =>
  netQtyK === 0 ? 0 : (mid - avgPx) * netQtyK;
