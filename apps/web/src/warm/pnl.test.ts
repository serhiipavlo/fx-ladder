import { describe, expect, it } from 'vitest';

import { midOf, unrealisedPnl } from './pnl';

describe('the client half of the P&L split (§7.3)', () => {
  it('long profits when mid rises, short profits when it falls, flat is zero', () => {
    expect(unrealisedPnl(500, 108_500, 108_520)).toBe(500 * 20);
    expect(unrealisedPnl(-500, 108_500, 108_480)).toBe(-500 * -20);
    expect(unrealisedPnl(0, 0, 108_500)).toBe(0);
  });

  it('midOf needs both sides of the top', () => {
    expect(midOf(undefined)).toBeNull();
    expect(midOf({ bids: [{ price: 108_497, size: 1 }], asks: [] })).toBeNull();
    expect(midOf({ bids: [{ price: 108_497, size: 1 }], asks: [{ price: 108_503, size: 1 }] })).toBe(108_500);
  });
});
