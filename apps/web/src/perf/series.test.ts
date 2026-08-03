import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createLoadSampler, latest, niceMax, sparkPath, type LoadSnapshot } from './series';

function snapshot(partial: Partial<LoadSnapshot>): LoadSnapshot {
  return {
    uptimeMs: 1000,
    sent: 0,
    framesSent: 0,
    tickP95: 0.5,
    clients: 1,
    renders: 0,
    wireBytesPerSec: 1024,
    ...partial,
  };
}

describe('load sampler', () => {
  it('needs two points to know a rate, then differentiates against the server clock', () => {
    const sampler = createLoadSampler();
    sampler.push(snapshot({ uptimeMs: 1000, sent: 5000, framesSent: 100 }));
    expect(sampler.samples()).toEqual([]); // one point is not a rate

    sampler.push(snapshot({ uptimeMs: 2000, sent: 55_000, framesSent: 225, renders: 60 }));
    const [sample] = sampler.samples();
    expect(sample!.recordsPerSec).toBe(50_000);
    expect(sample!.framesPerSec).toBe(125);
    expect(sample!.rendersPerSec).toBe(60); // one flush per screen frame
    expect(sample!.atMs).toBe(2000);
  });

  it('renders/s is honest in both render modes — the §6.4 contrast as a rate', () => {
    const coalesced = createLoadSampler();
    coalesced.push(snapshot({ uptimeMs: 1000, renders: 0 }));
    coalesced.push(snapshot({ uptimeMs: 2000, renders: 61 }));
    expect(coalesced.samples()[0]!.rendersPerSec).toBe(61);

    // Naive at the same load: a render per message, not per frame. The timing
    // instruments would have split across two fields here; the count does not.
    const naive = createLoadSampler();
    naive.push(snapshot({ uptimeMs: 1000, renders: 0 }));
    naive.push(snapshot({ uptimeMs: 2000, renders: 48_600 }));
    expect(naive.samples()[0]!.rendersPerSec).toBe(48_600);
  });

  it('a slow poll widens dt instead of inflating the rate', () => {
    const sampler = createLoadSampler();
    sampler.push(snapshot({ uptimeMs: 1000, sent: 0 }));
    // Four seconds passed (a paused tab, a stalled poll): 200k records over
    // 4 s is 50k/s, not 200k/s.
    sampler.push(snapshot({ uptimeMs: 5000, sent: 200_000 }));
    expect(sampler.samples()[0]!.recordsPerSec).toBe(50_000);
  });

  it('a restart reseeds instead of plotting a negative rate (ADR-10)', () => {
    const sampler = createLoadSampler();
    sampler.push(snapshot({ uptimeMs: 30_000, sent: 900_000 }));
    sampler.push(snapshot({ uptimeMs: 400, sent: 1200 })); // fresh container
    expect(sampler.samples()).toEqual([]);

    sampler.push(snapshot({ uptimeMs: 1400, sent: 51_200 }));
    expect(sampler.samples()).toHaveLength(1);
    expect(sampler.samples()[0]!.recordsPerSec).toBe(50_000);
  });

  it('never emits a negative or non-finite rate, for any pair of snapshots', () => {
    const snapshotArb = fc.record({
      uptimeMs: fc.integer({ min: 0, max: 10 ** 7 }),
      sent: fc.integer({ min: 0, max: 10 ** 9 }),
      framesSent: fc.integer({ min: 0, max: 10 ** 7 }),
      renders: fc.integer({ min: 0, max: 10 ** 7 }),
    });
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (a, b) => {
        const sampler = createLoadSampler();
        sampler.push(snapshot(a));
        sampler.push(snapshot(b));
        for (const sample of sampler.samples()) {
          expect(Number.isFinite(sample.recordsPerSec)).toBe(true);
          expect(sample.recordsPerSec).toBeGreaterThanOrEqual(0);
          expect(sample.framesPerSec).toBeGreaterThanOrEqual(0);
          expect(sample.rendersPerSec).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it('keeps only the last `capacity` samples', () => {
    const sampler = createLoadSampler(3);
    for (let i = 0; i <= 10; i += 1) {
      sampler.push(snapshot({ uptimeMs: 1000 * (i + 1), sent: 1000 * i }));
    }
    expect(sampler.samples()).toHaveLength(3);
    expect(sampler.samples()[2]!.atMs).toBe(11_000); // newest last
  });
});

describe('axis and path geometry', () => {
  it('the axis ceiling comes from the 1-2-5 ladder and never sits under the peak', () => {
    expect(niceMax([0.4])).toBe(1);
    expect(niceMax([1.2])).toBe(2);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7])).toBe(10);
    expect(niceMax([50_050])).toBe(100_000);
    expect(niceMax([], 4)).toBe(4); // empty keeps the floor
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 10 ** 6, noNaN: true }), { minLength: 1 }), (values) => {
        expect(niceMax(values)).toBeGreaterThanOrEqual(Math.max(...values));
      }),
    );
  });

  it('every point lands inside the box, higher values sit higher on screen', () => {
    const geometry = { width: 200, height: 40, max: 100, slots: 60 };
    expect(sparkPath([], geometry)).toBe('');
    expect(sparkPath([0], geometry)).toBe('M0,40'); // floor
    expect(sparkPath([100], geometry)).toBe('M0,0'); // ceiling
    // Out-of-range values clamp rather than escaping the viewBox.
    expect(sparkPath([500], geometry)).toBe('M0,0');
    expect(sparkPath([-5], geometry)).toBe('M0,40');

    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -100, max: 10_000, noNaN: true }), { minLength: 1, maxLength: 60 }),
        (values) => {
          const path = sparkPath(values, geometry);
          for (const [, x, y] of path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
            expect(Number(x)).toBeGreaterThanOrEqual(0);
            expect(Number(x)).toBeLessThanOrEqual(geometry.width);
            expect(Number(y)).toBeGreaterThanOrEqual(0);
            expect(Number(y)).toBeLessThanOrEqual(geometry.height);
          }
        },
      ),
    );
  });

  it('a zero ceiling draws a flat floor, not NaN', () => {
    expect(sparkPath([0, 0, 0], { width: 100, height: 20, max: 0, slots: 3 })).toBe('M0,20 L50,20 L100,20');
  });

  it('the series fills left to right across its slots', () => {
    const path = sparkPath([10, 20], { width: 100, height: 10, max: 20, slots: 5 });
    expect(path).toBe('M0,5 L25,0'); // two of five slots used, newest at 25%
  });

  it('latest is the current value, 0 before anything arrived', () => {
    expect(latest([])).toBe(0);
    expect(latest([1, 2, 3])).toBe(3);
  });
});
