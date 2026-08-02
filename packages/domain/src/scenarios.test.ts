import { describe, expect, it } from 'vitest';

import { pairIdOf } from './instruments';
import { DEMO_5MIN, SCENARIOS } from './scenarios';
import {
  simDisconnectBodySchema,
  simFreezeBodySchema,
  simLastLookBodySchema,
  simModeBodySchema,
  simNewsBodySchema,
  simRateBodySchema,
  simScenarioBodySchema,
} from './schemas';

// The timeline speaks the control plane's own language: every step's body
// must parse through the schema its /sim/* endpoint enforces — a scenario
// cannot command what a hand-typed request could not.

describe('scenario timelines (T-0.4.7)', () => {
  it('every demo-5min step parses through its own control schema', () => {
    for (const step of DEMO_5MIN) {
      expect(step.atMs).toBeGreaterThanOrEqual(0);
      switch (step.action) {
        case 'rate': {
          const body = { updatesPerSec: step.updatesPerSec };
          expect(simRateBodySchema.parse(body)).toEqual(body);
          break;
        }
        case 'mode': {
          const body = { batch: step.batch };
          expect(simModeBodySchema.parse(body)).toEqual(body);
          break;
        }
        case 'news': {
          const body = { pair: step.pair, pips: step.pips, spreadX: step.spreadX };
          expect(simNewsBodySchema.parse(body)).toEqual(body);
          // The server resolves timeline pairs inside a timer: they must be
          // provably in the catalogue, not merely six uppercase letters.
          expect(pairIdOf(step.pair)).toBeGreaterThanOrEqual(0);
          break;
        }
        case 'freeze': {
          const body = { pair: step.pair, ms: step.ms };
          expect(simFreezeBodySchema.parse(body)).toEqual(body);
          expect(pairIdOf(step.pair)).toBeGreaterThanOrEqual(0);
          break;
        }
        case 'lastlook': {
          const body = { holdMs: step.holdMs, rejectRate: step.rejectRate };
          expect(simLastLookBodySchema.parse(body)).toEqual(body);
          break;
        }
        case 'disconnect': {
          // afterMs is the schema's own default; the timeline carries timing.
          expect(simDisconnectBodySchema.parse({ graceful: step.graceful })).toEqual({
            graceful: step.graceful,
            afterMs: 0,
          });
          break;
        }
      }
    }
  });

  it('steps are ordered on the timeline and cover the §8 sequence', () => {
    for (let i = 1; i < DEMO_5MIN.length; i += 1) {
      expect(DEMO_5MIN[i]!.atMs).toBeGreaterThanOrEqual(DEMO_5MIN[i - 1]!.atMs);
    }
    const actions = DEMO_5MIN.map((s) => s.action);
    for (const required of ['rate', 'mode', 'disconnect', 'freeze', 'news', 'lastlook'] as const) {
      expect(actions).toContain(required);
    }
    // Five minutes, with the last minute left to the human's trade.
    expect(Math.max(...DEMO_5MIN.map((s) => s.atMs))).toBeLessThanOrEqual(240_000);
  });

  it('the registry and the body schema agree on scenario names', () => {
    for (const name of Object.keys(SCENARIOS)) {
      expect(simScenarioBodySchema.parse({ name })).toEqual({ name, speed: 1 });
    }
    expect(simScenarioBodySchema.safeParse({ name: 'unknown' }).success).toBe(false);
    expect(simScenarioBodySchema.safeParse({ name: 'demo-5min', speed: 0 }).success).toBe(false);
    expect(simScenarioBodySchema.safeParse({ name: 'demo-5min', speed: 601 }).success).toBe(false);
    expect(simScenarioBodySchema.parse({ name: 'demo-5min', speed: 100 })).toEqual({ name: 'demo-5min', speed: 100 });
  });
});
