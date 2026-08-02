// The demo as data (architecture §8): a scenario is a scripted sequence of
// control commands on a timeline. The five-minute demo of spec §8 starts
// with one call and plays identically every time; the same timeline is the
// backbone of the E2E suites. Steps speak the control plane's own language —
// each body below parses through the corresponding /sim/* schema, and a test
// holds that to be true.

export type ScenarioStep =
  | { atMs: number; action: 'rate'; updatesPerSec: number }
  | { atMs: number; action: 'mode'; batch: boolean }
  | { atMs: number; action: 'news'; pair: string; pips: number; spreadX: number }
  | { atMs: number; action: 'freeze'; pair: string; ms: number }
  | { atMs: number; action: 'lastlook'; holdMs: number; rejectRate: number }
  | { atMs: number; action: 'disconnect'; graceful: boolean };

/**
 * Spec §8, step by step. The last minute belongs to the human: last look is
 * armed, the market is calm enough to read, and the ticket is theirs to
 * click (step 6 — the one step no server can script).
 */
export const DEMO_5MIN: readonly ScenarioStep[] = [
  // 1 · Calm market — a known posture regardless of prior fiddling.
  { atMs: 0, action: 'rate', updatesPerSec: 300 },
  { atMs: 0, action: 'mode', batch: true },
  { atMs: 0, action: 'lastlook', holdMs: 40, rejectRate: 0 },
  // 2 · Spike — feed frequency to the AC-01 peak.
  { atMs: 30_000, action: 'rate', updatesPerSec: 50_000 },
  // 3 · Comparison — the §6.4 pathology at peak, then recovery. (The client
  //     half of this step is the render switch on the demo panel.)
  { atMs: 90_000, action: 'mode', batch: false },
  { atMs: 110_000, action: 'mode', batch: true },
  // 4 · Disconnect — a simulated crash; the client owes backoff + resnapshot.
  { atMs: 120_000, action: 'disconnect', graceful: false },
  // 5 · Recovery — the reconnect is the client's own; the market calms so
  //     the ladder reads at human pace again.
  { atMs: 140_000, action: 'rate', updatesPerSec: 2_000 },
  // Stale ≠ disconnected: one pair goes silent while the channel lives.
  { atMs: 195_000, action: 'freeze', pair: 'USDJPY', ms: 10_000 },
  // News: the jump and the spread arrive together, then decay.
  { atMs: 225_000, action: 'news', pair: 'GBPUSD', pips: 80, spreadX: 6 },
  // 6 · Trade — last look armed for controlled rejections; the click is yours.
  { atMs: 240_000, action: 'lastlook', holdMs: 80, rejectRate: 0.3 },
];

export const SCENARIOS: Record<'demo-5min', readonly ScenarioStep[]> = {
  'demo-5min': DEMO_5MIN,
};

export type ScenarioName = keyof typeof SCENARIOS;
