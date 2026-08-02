import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { prngFromState, xoshiro128 } from './prng';

const uint32Arb = fc.integer({ min: 0, max: 0xffff_ffff });

function draw(count: number, prng: { nextUint32(): number }): number[] {
  return Array.from({ length: count }, () => prng.nextUint32());
}

describe('determinism (done-when of T-0.1.2)', () => {
  it('same seed → identical sequences', () => {
    fc.assert(
      fc.property(uint32Arb, (seed) => {
        expect(draw(200, xoshiro128(seed))).toEqual(draw(200, xoshiro128(seed)));
      }),
    );
  });

  it('a state restored mid-sequence continues identically', () => {
    fc.assert(
      fc.property(uint32Arb, fc.integer({ min: 0, max: 500 }), fc.integer({ min: 1, max: 500 }), (seed, k, m) => {
        const original = xoshiro128(seed);
        draw(k, original);
        const snapshot = original.state();
        const resumed = prngFromState(snapshot);
        expect(draw(m, resumed)).toEqual(draw(m, original));
      }),
    );
  });

  it('state survives JSON serialization', () => {
    const original = xoshiro128(42);
    draw(17, original);
    const wire = JSON.stringify(original.state());
    const resumed = prngFromState(JSON.parse(wire) as [number, number, number, number]);
    expect(draw(50, resumed)).toEqual(draw(50, original));
  });
});

describe('output shape', () => {
  it('nextUint32 emits uint32s, nextFloat emits [0, 1)', () => {
    fc.assert(
      fc.property(uint32Arb, (seed) => {
        const prng = xoshiro128(seed);
        for (let i = 0; i < 100; i += 1) {
          const u = prng.nextUint32();
          expect(Number.isInteger(u) && u >= 0 && u <= 0xffff_ffff).toBe(true);
          const f = prng.nextFloat();
          expect(f >= 0 && f < 1).toBe(true);
        }
      }),
    );
  });

  it('distinct seeds diverge', () => {
    expect(draw(10, xoshiro128(1))).not.toEqual(draw(10, xoshiro128(2)));
  });

  it('a fixed seed pins its stream (regression anchor)', () => {
    // An anchor, not a reference vector: if the algorithm or seeding ever
    // changes these literals fail, and the change must be called out as
    // breaking — bit-identical replays are a contract (architecture §5.1).
    expect(draw(4, xoshiro128(42))).toEqual([660444221, 3652823732, 77672526, 910233633]);
  });
});

describe('input validation', () => {
  it.each([-1, 1.5, 0x1_0000_0000, Number.NaN])('rejects seed %s', (seed) => {
    expect(() => xoshiro128(seed)).toThrow();
  });

  it('rejects malformed states', () => {
    expect(() => prngFromState([0, 0, 0, 0])).toThrow();
    expect(() => prngFromState([1, 2, 3, 4.5])).toThrow();
    expect(() => prngFromState([1, 2, 3, -1])).toThrow();
  });
});
