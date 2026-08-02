import type { PairBook } from '../stream/core';

// The §7.3 P&L split, client half: realised comes from the server and moves
// only on trade events; unrealised is this multiplication against the hot
// mid and moves with every tick. Pushing it through GraphQL would drag hot
// tempo through the warm channel — the client already holds both inputs.

/** Mid of a book's top, or null while either side is missing. */
export function midOf(book: PairBook | undefined): number | null {
  const bid = book?.bids[0];
  const ask = book?.asks[0];
  if (bid == null || ask == null) return null;
  return (bid.price + ask.price) / 2;
}

/** Unrealised P&L in pipette·K units — same units as the server's realised. */
export function unrealisedPnl(netQtyK: number, avgPx: number, mid: number): number {
  if (netQtyK === 0) return 0;
  return (mid - avgPx) * netQtyK;
}
