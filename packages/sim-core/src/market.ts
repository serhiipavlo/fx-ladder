import { INSTRUMENTS, pairIdOf, toPipettes } from '@fx/domain';

import { xoshiro128, type Prng } from './prng';

// The market model (architecture §5.2–5.4): a bounded random walk of each
// pair's mid around its anchor, a fixed per-pair spread, and a small static
// book of levels per side. Recognizable, fully steerable, and deliberately no
// more — the client cannot tell where a number came from, only its shape,
// pace and timing.

export type Side = 'bid' | 'ask';

/**
 * One book-level upsert — the shape of a wire record minus `seq`, which is
 * assigned last in the server's send pipeline, never here (architecture §6.2).
 */
export interface LevelRecord {
  pairId: number;
  side: Side;
  level: number;
  /** Integer pipettes (ADR-06). */
  price: number;
  /** Thousands of base currency; never 0 in the v0.1 model (levels persist). */
  size: number;
}

export interface Market {
  /**
   * Advance the model to `now` (ms, monotonic) and return the level events
   * generated since the previous call. The first call only anchors the clock.
   */
  advance(now: number): LevelRecord[];
  /** Full current book — the material of SNAPSHOT frames (ADR-08). */
  snapshot(): LevelRecord[];
  /** Target event rate; records per second on the wire (plan §3, v0.1 cap). */
  setRate(updatesPerSec: number): void;
  /**
   * News shock (§5.3): jump the mid by `pips` and widen the spread by
   * `spreadX`, decaying back to baseline. Both land at the next advance —
   * the jump and the widening arrive together, as they should.
   */
  news(pairId: number, pips: number, spreadX: number): void;
}

export const BOOK_LEVELS = 4;

// Per-pair simulation parameters, keyed by catalogue symbol. Integer pipettes
// throughout: `step` is the walk increment, `spread` the fixed bid/ask gap,
// `levelGap` the distance between book levels. Amplitudes differ so the board
// does not look uniform (§5.2).
const PAIR_PARAMS = [
  { symbol: 'EURUSD', anchor: '1.08500', step: 2, spread: 6, levelGap: 8 },
  { symbol: 'GBPUSD', anchor: '1.27000', step: 3, spread: 9, levelGap: 10 },
  { symbol: 'USDJPY', anchor: '157.000', step: 3, spread: 8, levelGap: 10 },
  { symbol: 'USDCHF', anchor: '0.90500', step: 2, spread: 10, levelGap: 10 },
  { symbol: 'AUDUSD', anchor: '0.66500', step: 3, spread: 9, levelGap: 10 },
  { symbol: 'NZDUSD', anchor: '0.61200', step: 3, spread: 12, levelGap: 12 },
  { symbol: 'USDCAD', anchor: '1.36500', step: 2, spread: 9, levelGap: 10 },
  { symbol: 'EURGBP', anchor: '0.85400', step: 2, spread: 10, levelGap: 10 },
  { symbol: 'EURJPY', anchor: '170.400', step: 4, spread: 12, levelGap: 12 },
  { symbol: 'GBPJPY', anchor: '199.500', step: 5, spread: 15, levelGap: 14 },
  { symbol: 'USDTRY', anchor: '34.50000', step: 25, spread: 120, levelGap: 60 },
  { symbol: 'USDMXN', anchor: '17.15000', step: 15, spread: 90, levelGap: 45 },
] as const;

/** The walk is pulled back once it strays this many steps from the anchor. */
const MAX_DEVIATION_STEPS = 100;

const MIN_SIZE = 200;
const MAX_SIZE = 5000;

/** A news-widened spread returns to baseline over this window (§5.3). */
export const NEWS_DECAY_MS = 10_000;

interface PairState {
  pairId: number;
  anchor: number;
  mid: number;
  step: number;
  /** Effective spread; equals `spreadBase` outside a news window. */
  spread: number;
  spreadBase: number;
  levelGap: number;
  maxDeviation: number;
  /** sizes[0] = bid side, sizes[1] = ask side, indexed by level. */
  sizes: [number[], number[]];
  /** Pending news: mid jump in pipettes, applied at the next advance. */
  pendingJumpPipettes: number;
  /** Spread multiplier at news time; decays linearly to 1 over NEWS_DECAY_MS. */
  newsSpreadX: number;
  /** Command landed, decay clock not stamped yet — the next advance stamps it. */
  newsArmed: boolean;
  /** advance-clock timestamp the decay runs from; null = no active news. */
  newsAt: number | null;
  /** Full both-side refresh owed to the wire at the next advance. */
  refreshPending: boolean;
}

function initialSizes(prng: Prng): number[] {
  return Array.from({ length: BOOK_LEVELS }, (_, level) => {
    const base = 600 + level * 700;
    return base + (prng.nextUint32() % 400);
  });
}

/** Records for every level of both sides of one pair, from current state. */
function pairRecords(pair: PairState, out: LevelRecord[]): void {
  const bidTop = pair.mid - Math.ceil(pair.spread / 2);
  const askTop = bidTop + pair.spread;
  for (let level = 0; level < BOOK_LEVELS; level += 1) {
    out.push({
      pairId: pair.pairId,
      side: 'bid',
      level,
      price: bidTop - level * pair.levelGap,
      size: pair.sizes[0][level]!,
    });
    out.push({
      pairId: pair.pairId,
      side: 'ask',
      level,
      price: askTop + level * pair.levelGap,
      size: pair.sizes[1][level]!,
    });
  }
}

export function createMarket(seed: number, updatesPerSec = 1000): Market {
  const prng = xoshiro128(seed);
  let rate = validateRate(updatesPerSec);
  let lastNow: number | null = null;
  let carry = 0;

  const pairs: PairState[] = PAIR_PARAMS.map((params) => {
    // Alignment of PAIR_PARAMS with the catalogue is asserted by a test, so
    // the lookups below are total by construction.
    const pairId = pairIdOf(params.symbol);
    const instrument = INSTRUMENTS[pairId]!;
    return {
      pairId,
      anchor: toPipettes(params.anchor, instrument.precision),
      mid: toPipettes(params.anchor, instrument.precision),
      step: params.step,
      spread: params.spread,
      spreadBase: params.spread,
      levelGap: params.levelGap,
      maxDeviation: params.step * MAX_DEVIATION_STEPS,
      sizes: [initialSizes(prng), initialSizes(prng)],
      pendingJumpPipettes: 0,
      newsSpreadX: 1,
      newsArmed: false,
      newsAt: null,
      refreshPending: false,
    };
  });

  const midMoveCost = 2 * BOOK_LEVELS;

  function validateRate(value: number): number {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`updatesPerSec must be a positive integer, got ${value}`);
    }
    return value;
  }

  function moveMid(pair: PairState, out: LevelRecord[]): void {
    const deviation = pair.mid - pair.anchor;
    // Soft tether: the further from the anchor, the likelier the step points
    // back — a plain walk would drift into nonsense within minutes (§5.2).
    const pullProbability = 0.5 + 0.5 * Math.min(1, Math.abs(deviation) / pair.maxDeviation);
    const towardAnchor = deviation > 0 ? -1 : 1;
    const direction = prng.nextFloat() < pullProbability ? towardAnchor : -towardAnchor;
    pair.mid += direction * pair.step;
    pairRecords(pair, out);
  }

  function jiggleSize(pair: PairState, out: LevelRecord[]): void {
    const sideIndex = prng.nextUint32() % 2;
    // Top of book twitches the most (§5.4).
    const roll = prng.nextFloat();
    const level = roll < 0.5 ? 0 : roll < 0.75 ? 1 : roll < 0.9 ? 2 : 3;
    const sizes = pair.sizes[sideIndex === 0 ? 0 : 1];
    const current = sizes[level]!;
    const delta = (prng.nextUint32() % 301) - 150;
    const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, current + delta));
    sizes[level] = next;

    const bidTop = pair.mid - Math.ceil(pair.spread / 2);
    const top = sideIndex === 0 ? bidTop : bidTop + pair.spread;
    const direction = sideIndex === 0 ? -1 : 1;
    out.push({
      pairId: pair.pairId,
      side: sideIndex === 0 ? 'bid' : 'ask',
      level,
      price: top + direction * level * pair.levelGap,
      size: next,
    });
  }

  return {
    advance(now: number): LevelRecord[] {
      if (lastNow !== null && now < lastNow) {
        throw new Error(`now must be monotonic: ${now} < ${lastNow}`);
      }
      if (lastNow === null) {
        lastNow = now;
        return [];
      }
      // The action sequence is a pure function of the PRNG: how the budget is
      // sliced into ticks decides only how many actions have run by `now`,
      // never which ones. A mid move may overdraw the current slice — the
      // deficit carries forward — so every stream from one (seed, commands)
      // pair is a prefix of the same infinite record stream (§5.1).
      let credit = carry + ((now - lastNow) * rate) / 1000;
      lastNow = now;

      const out: LevelRecord[] = [];
      // News effects first: the jump lands, the spread decays on this clock,
      // and an owed refresh puts the shock on the wire immediately — command
      // effects ride outside the rate budget.
      for (const pair of pairs) {
        if (pair.newsArmed) {
          pair.newsAt = now;
          pair.newsArmed = false;
        }
        if (pair.newsAt !== null) {
          const elapsed = now - pair.newsAt;
          if (elapsed >= NEWS_DECAY_MS) {
            pair.spread = pair.spreadBase;
            pair.newsAt = null;
            pair.newsSpreadX = 1;
            pair.refreshPending = true;
          } else {
            const multiplier = 1 + (pair.newsSpreadX - 1) * (1 - elapsed / NEWS_DECAY_MS);
            pair.spread = Math.max(2, Math.round(pair.spreadBase * multiplier));
          }
        }
        if (pair.pendingJumpPipettes !== 0) {
          pair.mid += pair.pendingJumpPipettes;
          pair.pendingJumpPipettes = 0;
        }
        if (pair.refreshPending) {
          pairRecords(pair, out);
          pair.refreshPending = false;
        }
      }
      while (credit >= 1) {
        const pair = pairs[prng.nextUint32() % pairs.length] as PairState;
        if (prng.nextFloat() < 0.25) {
          moveMid(pair, out);
          credit -= midMoveCost;
        } else {
          jiggleSize(pair, out);
          credit -= 1;
        }
      }
      carry = credit;
      return out;
    },

    snapshot(): LevelRecord[] {
      const out: LevelRecord[] = [];
      for (const pair of pairs) pairRecords(pair, out);
      return out;
    },

    setRate(updatesPerSec: number): void {
      rate = validateRate(updatesPerSec);
    },

    news(pairId: number, pips: number, spreadX: number): void {
      const pair = pairs[pairId];
      if (pair === undefined) throw new Error(`unknown pairId: ${pairId}`);
      if (!Number.isInteger(pips) || pips === 0) throw new Error(`pips must be a non-zero integer, got ${pips}`);
      if (!(spreadX >= 1) || spreadX > 20) throw new Error(`spreadX must be in [1, 20], got ${spreadX}`);
      // One pip is ten pipettes for every catalogued pair (§5.2).
      pair.pendingJumpPipettes += pips * 10;
      pair.newsSpreadX = spreadX;
      pair.newsArmed = true;
      pair.newsAt = null;
      pair.refreshPending = true;
    },
  };
}
