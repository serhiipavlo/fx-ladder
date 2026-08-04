import { MAX_ORDER_QTY_K } from '@fx/domain';

import type { ReadonlyPairBook } from '../stream/core';

// The depth ladder's arithmetic (FR-05/06), pure like every other module that
// only computes: a book side in, plottable rows out — no React, no DOM, no
// clock. The whole book has been on the client since v0.1 (the core stores
// every level it decodes, §5.4); until now only level 0 was ever drawn.
//
// Prices stay integer pipettes here as everywhere else (ADR-06). The walk
// average is the one genuinely fractional number in the file, and it is
// rounded back onto the pipette grid rather than carried as a float: the
// grid IS the price resolution, and a formatter that renders halves of a
// pipette would be inventing precision the market model does not have.

/** A book side, in the order the wire numbers it: index 0 is the best price. */
export type BookSide = 'bid' | 'ask';

export interface DepthRow {
  /** Level index as the wire numbers it; 0 is top of book. */
  level: number;
  /** This level's own price, pipettes. */
  price: number;
  /** This level's own size, thousands of base. */
  size: number;
  /** Volume available down to and including this level (FR-06). */
  cumSize: number;
  /**
   * Volume-weighted average price of taking everything down to this level —
   * "the cost of walking the volume" (FR-06), pipettes, rounded to the grid.
   *
   * Indicative, and the plan says so out loud: fills are scripted (§5.5, per
   * withdrawn ADR-04), so an execution's price does not derive from the depth
   * shown here. The real matching engine in backlog §5 is what would make
   * this number binding rather than illustrative.
   */
  avgPx: number;
}

/** What a click on a depth level asks the ticket for (FR-07). */
export interface DepthPick {
  pair: string;
  /** The side you would trade: buy from the asks, sell into the bids. */
  side: 'buy' | 'sell';
  /**
   * What to ask for: the cumulative volume down to the clicked level, capped
   * at what the engine will accept.
   */
  qtyK: number;
  /** The clicked level's own price, pipettes. */
  priceP: number;
  /** VWAP of the walk to it, pipettes. */
  avgPxP: number;
  /**
   * The walk was deeper than one order may be, so `qtyK` is the ceiling
   * rather than the whole walk. Four levels of up to 5000K each reach twice
   * the engine's limit, so this is reachable in ordinary use, not a corner —
   * and a ticket that silently disagreed with the panel above it would be
   * the one lie this feature could tell.
   */
  capped: boolean;
}

/** Turns one side of a book into cumulative depth rows. */
interface DepthRowBuilder {
  (book: ReadonlyPairBook | undefined, side: BookSide): DepthRow[];
}

/** Names the order side a click on a book side implies. */
interface TakerSideResolver {
  (side: BookSide): 'buy' | 'sell';
}

/** Builds the ticket request a clicked row stands for. */
interface PickBuilder {
  (pair: string, side: BookSide, row: DepthRow): DepthPick;
}

/**
 * Rows for one side, best price first. Levels the book does not hold are
 * skipped rather than rendered empty — a missing level contributes no volume,
 * so including it would make the cumulative column lie — but the surviving
 * rows keep their own `level`, so what is drawn still says where on the wire
 * it came from.
 */
export const depthRows: DepthRowBuilder = (book, side) => {
  const levels = side === 'bid' ? book?.bids : book?.asks;
  if (levels === undefined) return [];

  const rows: DepthRow[] = [];
  let cumSize = 0;
  let notional = 0;
  for (let level = 0; level < levels.length; level += 1) {
    const entry = levels[level];
    if (entry == null) continue;
    cumSize += entry.size;
    notional += entry.price * entry.size;
    rows.push({
      level,
      price: entry.price,
      size: entry.size,
      cumSize,
      avgPx: Math.round(notional / cumSize),
    });
  }
  return rows;
};

/**
 * You buy from the offers and sell into the bids. Naming it here rather than
 * inline at the click site keeps the one rule that a reader of the blotter
 * will check against the book in a single, tested place.
 */
export const takerSide: TakerSideResolver = (side) => (side === 'ask' ? 'buy' : 'sell');

export const pickOf: PickBuilder = (pair, side, row) => ({
  pair,
  side: takerSide(side),
  qtyK: Math.min(row.cumSize, MAX_ORDER_QTY_K),
  priceP: row.price,
  avgPxP: row.avgPx,
  capped: row.cumSize > MAX_ORDER_QTY_K,
});
