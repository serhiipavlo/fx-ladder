import { describe, expect, it } from 'vitest';

import { percentile } from './percentile';

describe('percentile', () => {
  it('nearest-rank on small sets, 0 on empty', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
  });
});
