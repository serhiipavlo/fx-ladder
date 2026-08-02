import { expect, it } from 'vitest';

import { BOOK_LEVELS, createMarket, prngFromState, xoshiro128 } from './index';

it('the public entry exposes the market and the PRNG', () => {
  expect(typeof createMarket).toBe('function');
  expect(typeof xoshiro128).toBe('function');
  expect(typeof prngFromState).toBe('function');
  expect(BOOK_LEVELS).toBeGreaterThan(0);
});
