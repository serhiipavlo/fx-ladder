import { decodeFrame, decodeFrameBinary, type Frame, type WireRecord } from '@fx/protocol';

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

/**
 * What `books()` hands out. The core owns the only writable reference; a
 * reader that wants a different book builds its own.
 */
export interface ReadonlyPairBook {
  readonly bids: ReadonlyArray<Level | null>;
  readonly asks: ReadonlyArray<Level | null>;
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
  /** Cumulative wire cost, bytes — counted before decoding: damage costs too. */
  wireBytes: number;
  lastSeq: number | null;
  lastFrameAt: number | null;
}

/** One message's wire cost, stamped with the client clock that received it. */
interface ByteSample {
  at: number;
  bytes: number;
}

/** Applies one wire record into the book map, in place. */
interface RecordApplier {
  (books: Map<number, PairBook>, record: WireRecord): void;
}

/** Trailing-window byte meter: costs go in as they arrive, the rate comes out. */
interface ByteWindow {
  add(at: number, bytes: number): void;
  sum(now: number): number;
}

/** Builds an empty byte meter. */
interface ByteWindowFactory {
  (): ByteWindow;
}

/** Builds a fresh sans-I/O core. */
interface StreamCoreFactory {
  (): StreamCore;
}

/** No frame for this long while live = the channel is dead (3× the heartbeat interval). */
export const DEAD_AFTER_MS = 3000;

/** The window `bytesPerSec` reports over — the meter's one definition of "per sec". */
const RATE_WINDOW_MS = 1000;

/**
 * One record is a full upsert of one level: applying it twice is a no-op by
 * construction, size 0 clears the level (§6.1).
 */
export const applyRecord: RecordApplier = (books, record) => {
  let book = books.get(record.pairId);
  if (book === undefined) {
    book = { bids: [], asks: [] };
    books.set(record.pairId, book);
  }
  const side = record.side === 'bid' ? book.bids : book.asks;
  side[record.level] = record.size === 0 ? null : { price: record.price, size: record.size };
};

/**
 * Samples leave through a moving head rather than shift(): `add` runs once per
 * wire message, and the window is the busiest thing on that path.
 */
const createByteWindow: ByteWindowFactory = () => {
  const samples: ByteSample[] = [];
  /** Index of the oldest live sample; everything below it has already expired. */
  let head = 0;
  let total = 0;

  const prune = (now: number): void => {
    while (head < samples.length && now - samples[head]!.at > RATE_WINDOW_MS) {
      total -= samples[head]!.bytes;
      head += 1;
    }
    // Reclaim the dead prefix, but not on every message: a silent channel
    // empties outright, a busy one compacts once the prefix is worth the copy.
    if (head === samples.length) {
      samples.length = 0;
      head = 0;
    } else if (head > 256) {
      samples.splice(0, head);
      head = 0;
    }
  };

  return {
    add(at, bytes) {
      samples.push({ at, bytes });
      total += bytes;
      prune(at);
    },
    sum(now) {
      prune(now); // silence expires too — the meter must fall to zero unfed
      return total;
    },
  };
};

export interface StreamCore {
  /**
   * Feed one raw wire message — JSON text (fx.v1) or a binary frame
   * (fx.v2, ADR-12); `now` is the client clock in ms. One core, two wires,
   * the same frames after decode.
   */
  onMessage(data: string | ArrayBuffer, now: number): StreamEvent[];
  /** Drive the heartbeat watchdog; call periodically with the client clock. */
  onTick(now: number): StreamEvent[];
  /** Wire bytes received over the trailing second — the live cost of the feed. */
  bytesPerSec(now: number): number;
  status(): StreamStatus;
  books(): ReadonlyMap<number, ReadonlyPairBook>;
  /**
   * The live stats object, not a copy: it mutates in place as frames land, and
   * `version()` is what tells a subscriber to look again.
   */
  stats(): Readonly<StreamStats>;
  /** Monotonic change counter for whole-state subscribers. */
  version(): number;
  /**
   * Per-pair change counters — the render-isolation contract: a row
   * re-renders only when its pair's counter moved (NFR-03).
   */
  pairVersions(): ReadonlyMap<number, number>;
  /** Client-clock moment this pair last updated; null before its first record. */
  pairUpdatedAt(pairId: number): number | null;
}

export const createStreamCore: StreamCoreFactory = () => {
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
    wireBytes: 0,
    lastSeq: null,
    lastFrameAt: null,
  };

  const wireRate = createByteWindow();

  let version = 0;
  const pairVersions = new Map<number, number>();
  const pairTouchedAt = new Map<number, number>();

  const bumpPair = (pairId: number, now: number): void => {
    pairVersions.set(pairId, (pairVersions.get(pairId) ?? 0) + 1);
    pairTouchedAt.set(pairId, now);
  };

  /**
   * Books this frame's records against the sequence: `count` of them, ending
   * at `firstSeq + count - 1`, and the next frame must start where it left off.
   */
  const advanceSeq = (firstSeq: number, count: number): void => {
    stats.records += count;
    stats.lastSeq = firstSeq + count - 1;
    expectedSeq = firstSeq + count;
  };

  const resync = (reason: ResyncReason): StreamEvent[] => {
    if (reason === 'gap' || reason === 'heartbeat-loss') stats.gaps += 1;
    if (reason === 'protocol-error') stats.protocolErrors += 1;
    status = 'resync';
    expectedSeq = null;
    version += 1;
    return [{ type: 'resync', reason }];
  };

  /**
   * Wholesale replacement — recovery and first connect are the same code path
   * on purpose (ADR-08).
   */
  const onSnapshot = (frame: Frame, now: number): StreamEvent[] => {
    books.clear();
    for (const record of frame.records) applyRecord(books, record);
    for (const pairId of books.keys()) bumpPair(pairId, now);
    advanceSeq(frame.firstSeq, frame.count);
    status = 'live';
    return [];
  };

  /**
   * Silence still proves completeness: the heartbeat carries the last assigned
   * seq, so loss shows up even with no new data (§6.3).
   */
  const onHeartbeat = (frame: Frame): StreamEvent[] => {
    stats.heartbeats += 1;
    if (expectedSeq !== null && frame.firstSeq !== expectedSeq - 1) {
      return resync('heartbeat-loss');
    }
    return [];
  };

  /** The wire is dense per connection — any mismatch is proven loss. */
  const onDelta = (frame: Frame, now: number): StreamEvent[] => {
    if (expectedSeq === null || frame.firstSeq !== expectedSeq) {
      return resync('gap');
    }
    for (const record of frame.records) {
      applyRecord(books, record);
      bumpPair(record.pairId, now);
    }
    advanceSeq(frame.firstSeq, frame.count);
    return [];
  };

  return {
    onMessage(data: string | ArrayBuffer, now: number): StreamEvent[] {
      // JSON text is ASCII here, so string length IS the byte count; binary
      // frames say theirs outright. Counted before decode: damage costs too.
      const bytes = typeof data === 'string' ? data.length : data.byteLength;
      stats.wireBytes += bytes;
      wireRate.add(now, bytes);

      let frame: Frame | null;
      try {
        frame = typeof data === 'string' ? decodeFrame(data) : decodeFrameBinary(data);
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

      if (frame.frameType === 'SNAPSHOT') return onSnapshot(frame, now);
      if (status !== 'live') return []; // ignore data until the next snapshot
      return frame.frameType === 'HEARTBEAT' ? onHeartbeat(frame) : onDelta(frame, now);
    },

    onTick(now: number): StreamEvent[] {
      if (status !== 'live') return [];
      if (stats.lastFrameAt !== null && now - stats.lastFrameAt > DEAD_AFTER_MS) {
        return resync('silence');
      }
      return [];
    },

    bytesPerSec: (now) => wireRate.sum(now),
    status: () => status,
    books: () => books,
    stats: () => stats,
    version: () => version,
    pairVersions: () => pairVersions,
    pairUpdatedAt: (pairId) => pairTouchedAt.get(pairId) ?? null,
  };
};
