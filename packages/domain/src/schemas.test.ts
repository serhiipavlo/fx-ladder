import { describe, expect, it } from 'vitest';

import { simGapBodySchema, simRateBodySchema, simSeedBodySchema } from './schemas';

describe('control-plane schemas (done-when of T-0.1.1: each rejects malformed bodies)', () => {
  it('POST /sim/seed accepts a uint32 seed', () => {
    expect(simSeedBodySchema.parse({ seed: 42 })).toEqual({ seed: 42 });
    expect(simSeedBodySchema.parse({ seed: 0xffff_ffff })).toEqual({ seed: 0xffff_ffff });
  });

  it.each([
    {},
    { seed: -1 },
    { seed: 1.5 },
    { seed: 0x1_0000_0000 },
    { seed: '42' },
    { seed: 42, extra: true },
  ])('POST /sim/seed rejects %j', (bad) => {
    expect(simSeedBodySchema.safeParse(bad).success).toBe(false);
  });

  it('POST /sim/rate accepts rates up to the v0.2 cap', () => {
    expect(simRateBodySchema.parse({ updatesPerSec: 5000 })).toEqual({ updatesPerSec: 5000 });
    expect(simRateBodySchema.parse({ updatesPerSec: 50_000 })).toEqual({ updatesPerSec: 50_000 });
  });

  it.each([{}, { updatesPerSec: 0 }, { updatesPerSec: -5 }, { updatesPerSec: 500_000 }, { updatesPerSec: 'fast' }])(
    'POST /sim/rate rejects %j',
    (bad) => {
      expect(simRateBodySchema.safeParse(bad).success).toBe(false);
    },
  );

  it('POST /sim/gap accepts a positive skip count', () => {
    expect(simGapBodySchema.parse({ skipSeqs: 40 })).toEqual({ skipSeqs: 40 });
  });

  it.each([{}, { skipSeqs: 0 }, { skipSeqs: 2.5 }, { skipSeqs: 1_000_000 }, { skipSeqs: null }])(
    'POST /sim/gap rejects %j',
    (bad) => {
      expect(simGapBodySchema.safeParse(bad).success).toBe(false);
    },
  );
});
