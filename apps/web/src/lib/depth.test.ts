import { MAX_ORDER_QTY_K } from '@fx/domain';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { encodeFrame, type Frame } from '@fx/protocol';
import { describe, expect, it } from 'vitest';

import { createStreamCore } from '../stream/core';
import { depthRows, pickOf, takerSide } from './depth';

// The done-when of T-1.3.1, arithmetic half: cumulative volume and the cost of
// walking it (FR-06), computed over the book the core already holds.

const normal = normalJson as unknown as Frame[];
const SNAPSHOT = normal[0]!;

/** The real EURUSD book of seed 42, decoded exactly as the page decodes it. */
const seededBook = () => {
  const core = createStreamCore();
  core.onMessage(encodeFrame(SNAPSHOT), SNAPSHOT.serverTs);
  return core.books().get(0);
};

describe('depth rows (done-when of T-1.3.1)', () => {
  it('accumulates volume down the side and averages the walk against it', () => {
    const book = {
      bids: [
        { price: 108_497, size: 600 },
        { price: 108_489, size: 1300 },
      ],
      asks: [{ price: 108_503, size: 400 }],
    };

    const bids = depthRows(book, 'bid');
    expect(bids.map((row) => row.cumSize)).toEqual([600, 1900]);
    // Level 0 alone: the average IS its price.
    expect(bids[0]!.avgPx).toBe(108_497);
    // Two levels: (108497·600 + 108489·1300) / 1900 = 108491.52… → 108492.
    expect(bids[1]!.avgPx).toBe(Math.round((108_497 * 600 + 108_489 * 1300) / 1900));

    const asks = depthRows(book, 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toEqual({ level: 0, price: 108_503, size: 400, cumSize: 400, avgPx: 108_503 });
  });

  it('skips levels the book does not hold, and keeps the wire level of those it does', () => {
    // A level that went to size 0 is stored as null (§5.4: disappearance is an
    // ordinary record). It must contribute no volume — but the levels around
    // it must still report where on the wire they came from.
    const book = {
      bids: [{ price: 108_497, size: 600 }, null, { price: 108_481, size: 900 }],
      asks: [],
    };
    const rows = depthRows(book, 'bid');
    expect(rows.map((row) => row.level)).toEqual([0, 2]);
    expect(rows.map((row) => row.cumSize)).toEqual([600, 1500]);
    expect(depthRows(book, 'ask')).toEqual([]);
  });

  it('has no opinion about a book it was not given', () => {
    expect(depthRows(undefined, 'bid')).toEqual([]);
    expect(depthRows(undefined, 'ask')).toEqual([]);
  });

  it('holds the walk invariants on the real seeded book', () => {
    const book = seededBook();
    expect(book).toBeDefined();

    for (const side of ['bid', 'ask'] as const) {
      const rows = depthRows(book, side);
      expect(rows.length).toBeGreaterThan(1);

      let previousCum = 0;
      for (const row of rows) {
        // Cumulative volume only grows, and by exactly this level's size.
        expect(row.cumSize).toBe(previousCum + row.size);
        previousCum = row.cumSize;

        // The average of a walk always lies between the best price and the
        // worst one taken — the invariant that makes it readable as a cost.
        const best = rows[0]!.price;
        const lo = Math.min(best, row.price);
        const hi = Math.max(best, row.price);
        expect(row.avgPx).toBeGreaterThanOrEqual(lo);
        expect(row.avgPx).toBeLessThanOrEqual(hi);
      }

      // Walking deeper never improves the average: bids walk down, asks walk up.
      for (let i = 1; i < rows.length; i += 1) {
        const previous = rows[i - 1]!.avgPx;
        const current = rows[i]!.avgPx;
        if (side === 'bid') expect(current).toBeLessThanOrEqual(previous);
        else expect(current).toBeGreaterThanOrEqual(previous);
      }
    }
  });
});

describe('a clicked level as a ticket request (FR-07)', () => {
  it('buys from the offers and sells into the bids', () => {
    expect(takerSide('ask')).toBe('buy');
    expect(takerSide('bid')).toBe('sell');
  });

  it('asks for the volume the walk actually takes, and carries both prices', () => {
    const row = { level: 1, price: 108_511, size: 1300, cumSize: 1900, avgPx: 108_508 };
    expect(pickOf('EURUSD', 'ask', row)).toEqual({
      pair: 'EURUSD',
      side: 'buy',
      qtyK: 1900, // cumulative, not this level's own size
      priceP: 108_511,
      avgPxP: 108_508,
      capped: false,
    });
  });

  it('never asks for more than the engine accepts, and says when it had to cut', () => {
    // Four levels of up to 5000K reach twice the ceiling, so a deep walk
    // running past it is ordinary — the ticket must not be handed a quantity
    // that comes back INVALID_QTY.
    const deep = { level: 3, price: 108_540, size: 5000, cumSize: 18_000, avgPx: 108_520 };
    const pick = pickOf('EURUSD', 'ask', deep);
    expect(pick.qtyK).toBe(MAX_ORDER_QTY_K);
    expect(pick.capped).toBe(true);

    // Exactly at the ceiling is not a cut.
    const exact = pickOf('EURUSD', 'ask', { ...deep, cumSize: MAX_ORDER_QTY_K });
    expect(exact.qtyK).toBe(MAX_ORDER_QTY_K);
    expect(exact.capped).toBe(false);
  });
});
