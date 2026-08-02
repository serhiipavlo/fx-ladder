import { decodeFrame, type Frame, type WireRecord } from '@fx/protocol';

// The stream layer's core is sans-I/O, like sim-core: messages and clock
// ticks come in as arguments, resync decisions come out as events. The thin
// shell in connect.ts owns the socket and the timers; everything below is
// testable by replaying the recorded fixtures — no mocks, no fake timers.

export interface Level {
  price: number;
  size: number;
}

export interface PairBook {
  bids: Array<Level | null>;
  asks: Array<Level | null>;
}

export type StreamStatus = 'awaiting-snapshot' | 'live' | 'resync';

export type ResyncReason = 'gap' | 'heartbeat-loss' | 'protocol-error' | 'silence';

export interface StreamEvent {
  type: 'resync';
  reason: ResyncReason;
}

export interface StreamStats {
  frames: number;
  records: number;
  heartbeats: number;
  gaps: number;
  protocolErrors: number;
  lastSeq: number | null;
  lastFrameAt: number | null;
}

/** No frame for this long while live = the channel is dead (3× the heartbeat interval). */
export const DEAD_AFTER_MS = 3000;

/**
 * One record is a full upsert of one level: applying it twice is a no-op by
 * construction, size 0 clears the level (§6.1).
 */
export function applyRecord(books: Map<number, PairBook>, record: WireRecord): void {
  let book = books.get(record.pairId);
  if (book === undefined) {
    book = { bids: [], asks: [] };
    books.set(record.pairId, book);
  }
  const side = record.side === 'bid' ? book.bids : book.asks;
  side[record.level] = record.size === 0 ? null : { price: record.price, size: record.size };
}

export interface StreamCore {
  /** Feed one raw wire message; `now` is the client clock in ms. */
  onMessage(text: string, now: number): StreamEvent[];
  /** Drive the heartbeat watchdog; call periodically with the client clock. */
  onTick(now: number): StreamEvent[];
  status(): StreamStatus;
  books(): ReadonlyMap<number, PairBook>;
  stats(): Readonly<StreamStats>;
  /** Monotonic change counter for whole-state subscribers. */
  version(): number;
  /**
   * Per-pair change counters — the render-isolation contract: a row
   * re-renders only when its pair's counter moved (NFR-03).
   */
  pairVersions(): ReadonlyMap<number, number>;
}

export function createStreamCore(): StreamCore {
  let status: StreamStatus = 'awaiting-snapshot';
  /** seq the next data record must carry; null until a snapshot set the basis. */
  let expectedSeq: number | null = null;
  const books = new Map<number, PairBook>();
  const stats: StreamStats = {
    frames: 0,
    records: 0,
    heartbeats: 0,
    gaps: 0,
    protocolErrors: 0,
    lastSeq: null,
    lastFrameAt: null,
  };

  let version = 0;
  const pairVersions = new Map<number, number>();

  function bumpPair(pairId: number): void {
    pairVersions.set(pairId, (pairVersions.get(pairId) ?? 0) + 1);
  }

  function resync(reason: ResyncReason): StreamEvent[] {
    if (reason === 'gap' || reason === 'heartbeat-loss') stats.gaps += 1;
    if (reason === 'protocol-error') stats.protocolErrors += 1;
    status = 'resync';
    expectedSeq = null;
    version += 1;
    return [{ type: 'resync', reason }];
  }

  return {
    onMessage(text: string, now: number): StreamEvent[] {
      let frame: Frame | null;
      try {
        frame = decodeFrame(text);
      } catch {
        stats.lastFrameAt = now;
        // Structural damage is 4002 territory; while already resyncing the
        // shell is mid-reconnect and a second event would double-fire it.
        return status === 'resync' ? [] : resync('protocol-error');
      }
      if (frame === null) return []; // unknown frame type: skip silently (§6.1)

      stats.frames += 1;
      stats.lastFrameAt = now;
      version += 1;

      if (frame.frameType === 'SNAPSHOT') {
        // Wholesale replacement — recovery and first connect are the same
        // code path on purpose (ADR-08).
        books.clear();
        for (const record of frame.records) applyRecord(books, record);
        for (const pairId of books.keys()) bumpPair(pairId);
        stats.records += frame.count;
        stats.lastSeq = frame.count > 0 ? frame.firstSeq + frame.count - 1 : frame.firstSeq;
        expectedSeq = frame.firstSeq + frame.count;
        status = 'live';
        return [];
      }

      if (status !== 'live') return []; // ignore data until the next snapshot

      if (frame.frameType === 'HEARTBEAT') {
        stats.heartbeats += 1;
        // Silence still proves completeness: the heartbeat carries the last
        // assigned seq, so loss shows up even with no new data (§6.3).
        if (expectedSeq !== null && frame.firstSeq !== expectedSeq - 1) {
          return resync('heartbeat-loss');
        }
        return [];
      }

      // DELTA: the wire is dense per connection — any mismatch is proven loss.
      if (expectedSeq === null || frame.firstSeq !== expectedSeq) {
        return resync('gap');
      }
      for (const record of frame.records) {
        applyRecord(books, record);
        bumpPair(record.pairId);
      }
      stats.records += frame.count;
      stats.lastSeq = frame.firstSeq + frame.count - 1;
      expectedSeq = frame.firstSeq + frame.count;
      return [];
    },

    onTick(now: number): StreamEvent[] {
      if (status !== 'live') return [];
      if (stats.lastFrameAt !== null && now - stats.lastFrameAt > DEAD_AFTER_MS) {
        return resync('silence');
      }
      return [];
    },

    status: () => status,
    books: () => books,
    stats: () => stats,
    version: () => version,
    pairVersions: () => pairVersions,
  };
}
