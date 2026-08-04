import { z } from 'zod';

import { MAX_ORDER_QTY_K } from './orders';

// Control-plane bodies of v0.1.0 (architecture §8): one schema per endpoint,
// strict — unknown keys are a rejection, not a shrug ("parse, don't
// validate"). The server derives its 400 field-level reasons from these; the
// same objects are the TS types via z.infer.

/** POST /sim/seed — xoshiro128 seeds are uint32 (architecture §5.1). */
export const simSeedBodySchema = z.strictObject({
  seed: z.number().int().min(0).max(0xffff_ffff),
});
export type SimSeedBody = z.infer<typeof simSeedBodySchema>;

/** POST /sim/rate — v0.2.0 cap: room above the 50k target (plan §3); ratchet-only. */
export const simRateBodySchema = z.strictObject({
  updatesPerSec: z.number().int().min(1).max(100_000),
});
export type SimRateBody = z.infer<typeof simRateBodySchema>;

/** POST /sim/gap — skip N sequence numbers to exercise the gap detector (NFR-08). */
export const simGapBodySchema = z.strictObject({
  skipSeqs: z.number().int().min(1).max(100_000),
});
export type SimGapBody = z.infer<typeof simGapBodySchema>;

/**
 * POST /sim/news — price jump plus a decaying spread multiplier (architecture
 * §5.3, §8). The pair's existence is checked against the catalogue on the
 * server; the schema pins the shape.
 */
export const simNewsBodySchema = z.strictObject({
  pair: z.string().regex(/^[A-Z]{6}$/, 'pair is a six-letter symbol like GBPUSD'),
  pips: z
    .number()
    .int()
    .min(-1000)
    .max(1000)
    .refine((v) => v !== 0, 'pips must be non-zero'),
  spreadX: z.number().min(1).max(20),
});
export type SimNewsBody = z.infer<typeof simNewsBodySchema>;

/**
 * POST /sim/disconnect — drop every client: graceful (close 1000, the client
 * must NOT reconnect) versus a simulated crash (close 4000, the client comes
 * back with backoff + jitter). AC-04, NFR-07.
 */
export const simDisconnectBodySchema = z.strictObject({
  graceful: z.boolean(),
  afterMs: z.number().int().min(0).max(60_000).optional().default(0),
});
export type SimDisconnectBody = z.infer<typeof simDisconnectBodySchema>;

/** POST /sim/mode — the server half of the §6.4 contrast: batched tick frames vs one frame per update. */
export const simModeBodySchema = z.strictObject({
  batch: z.boolean(),
});
export type SimModeBody = z.infer<typeof simModeBodySchema>;

/**
 * POST /sim/freeze — one pair goes silent for `ms` while the channel stays
 * alive: stale ≠ disconnected (AC-06, architecture §8).
 */
export const simFreezeBodySchema = z.strictObject({
  pair: z.string().regex(/^[A-Z]{6}$/, 'pair is a six-letter symbol like USDJPY'),
  ms: z.number().int().min(100).max(600_000),
});
export type SimFreezeBody = z.infer<typeof simFreezeBodySchema>;

/** POST /sim/lastlook — the two knobs of §5.5: hold window and bounce probability. */
export const simLastLookBodySchema = z.strictObject({
  holdMs: z.number().int().min(0).max(10_000),
  rejectRate: z.number().min(0).max(1),
});
export type SimLastLookBody = z.infer<typeof simLastLookBodySchema>;

/**
 * POST /sim/blotter — load data that exists for real (architecture §5.4,
 * AC-11): `rows` synthetic orders enter through the same submit path as every
 * ticket, so the burst fills the ledger and rides the warm subscription. The
 * cap is the AC's own number.
 */
export const simBlotterBodySchema = z.strictObject({
  rows: z.number().int().min(1).max(5000),
});
export type SimBlotterBody = z.infer<typeof simBlotterBodySchema>;

/**
 * POST /sim/scenario — the demo as data (architecture §8): plays a named
 * timeline of control commands. `speed` compresses the timeline (offset ÷
 * speed) — ×1 is the live five-minute demo, tests run the same sequence in
 * seconds. A new scenario cancels whatever the previous one had pending.
 */
export const simScenarioBodySchema = z.strictObject({
  name: z.enum(['demo-5min']),
  speed: z.number().int().min(1).max(600).optional().default(1),
});
export type SimScenarioBody = z.infer<typeof simScenarioBodySchema>;

/**
 * POST /sim/order — the dev-harness door into the execution engine (T-0.3.6).
 * The user-facing order loop arrives with the warm plane in v0.4; this body
 * exists so the event grammar can be exercised and observed today.
 */
export const simOrderBodySchema = z.strictObject({
  clOrdId: z.string().min(1).max(64).optional(),
  pair: z.string().regex(/^[A-Z]{6}$/, 'pair is a six-letter symbol like EURUSD'),
  side: z.enum(['buy', 'sell']),
  qtyK: z.number().int().min(1).max(MAX_ORDER_QTY_K),
  tif: z.enum(['DAY', 'IOC']).optional().default('DAY'),
});
export type SimOrderBody = z.infer<typeof simOrderBodySchema>;
