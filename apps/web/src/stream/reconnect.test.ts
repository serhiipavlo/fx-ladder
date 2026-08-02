import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { reconnectDecision } from './reconnect';

describe('per-code reaction table (done-when of T-0.2.3)', () => {
  it('1000 produces no reconnect — the goodbye was deliberate', () => {
    fc.assert(
      fc.property(fc.nat(20), fc.double({ min: 0, max: 1, noNaN: true }), (attempt, random) => {
        const decision = reconnectDecision(1000, attempt, random);
        expect(decision.action).toBe('stop');
        expect(decision.delayMs).toBeUndefined();
      }),
    );
  });

  it('4002 stops and surfaces a protocol error', () => {
    const decision = reconnectDecision(4002, 0, 0.5);
    expect(decision.action).toBe('stop');
    expect(decision.label).toContain('protocol error');
  });

  it('4000 reconnects with growing delays for a fixed jitter draw', () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) => reconnectDecision(4000, attempt, 0.7).delayMs!);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('the delays are jittered — non-constant across random draws', () => {
    const a = reconnectDecision(4000, 3, 0.05).delayMs!;
    const b = reconnectDecision(4000, 3, 0.95).delayMs!;
    expect(a).not.toBe(b);
    expect(b).toBeGreaterThan(a);
  });

  it('backoff is bounded: never above 10 s, never below a quarter second', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(4000, 4001, 1006),
        fc.nat(50),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (code, attempt, random) => {
          const { delayMs } = reconnectDecision(code, attempt, random);
          expect(delayMs!).toBeLessThanOrEqual(10_000);
          expect(delayMs!).toBeGreaterThanOrEqual(250);
        },
      ),
    );
  });

  it('4001 retries but names the real cause — bandwidth, not weather', () => {
    const decision = reconnectDecision(4001, 0, 0.5);
    expect(decision.action).toBe('retry');
    expect(decision.label).toContain('falling behind');
  });

  it('unknown codes are treated as network weather and retried', () => {
    expect(reconnectDecision(1006, 2, 0.5).action).toBe('retry');
  });
});
