import { z } from 'zod';

// Control-plane bodies of v0.1.0 (architecture §8): one schema per endpoint,
// strict — unknown keys are a rejection, not a shrug ("parse, don't
// validate"). The server derives its 400 field-level reasons from these; the
// same objects are the TS types via z.infer.

/** POST /sim/seed — xoshiro128 seeds are uint32 (architecture §5.1). */
export const simSeedBodySchema = z.strictObject({
  seed: z.number().int().min(0).max(0xffff_ffff),
});
export type SimSeedBody = z.infer<typeof simSeedBodySchema>;

/** POST /sim/rate — capped low for v0.1.0 (plan §3); the cap ratchets up in v0.2.0. */
export const simRateBodySchema = z.strictObject({
  updatesPerSec: z.number().int().min(1).max(10_000),
});
export type SimRateBody = z.infer<typeof simRateBodySchema>;

/** POST /sim/gap — skip N sequence numbers to exercise the gap detector (NFR-08). */
export const simGapBodySchema = z.strictObject({
  skipSeqs: z.number().int().min(1).max(100_000),
});
export type SimGapBody = z.infer<typeof simGapBodySchema>;
