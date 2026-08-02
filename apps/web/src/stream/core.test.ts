import gapJson from '@fx/protocol/fixtures/gap-stream.json';
import heartbeatJson from '@fx/protocol/fixtures/heartbeat-silence.json';
import midstreamJson from '@fx/protocol/fixtures/midstream-snapshot.json';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { encodeFrame, heartbeatFrame, type Frame, type WireRecord } from '@fx/protocol';
import { describe, expect, it } from 'vitest';

import { applyRecord, createStreamCore, DEAD_AFTER_MS, type PairBook, type StreamEvent } from './core';

const normal = normalJson as unknown as Frame[];
const gap = gapJson as unknown as Frame[];
const midstream = midstreamJson as unknown as Frame[];
const heartbeatSilence = heartbeatJson as unknown as Frame[];

/** Replays fixture frames through the full decode path, clock = serverTs. */
function replay(core: ReturnType<typeof createStreamCore>, frames: Frame[]): StreamEvent[] {
  return frames.flatMap((frame) => core.onMessage(encodeFrame(frame), frame.serverTs));
}

describe('normal stream', () => {
  it('goes live, builds all five books, keeps bid < ask', () => {
    const core = createStreamCore();
    const events = replay(core, normal);

    expect(events).toEqual([]);
    expect(core.status()).toBe('live');
    expect(core.books().size).toBe(5);
    for (const [, book] of core.books()) {
      expect(book.bids[0]!.price).toBeLessThan(book.asks[0]!.price);
    }
    expect(core.stats().gaps).toBe(0);
    expect(core.stats().records).toBeGreaterThan(100);
    expect(core.stats().lastSeq).toBe(
      normal[normal.length - 1]!.firstSeq + normal[normal.length - 1]!.count - 1,
    );
  });
});

describe('gap stream (done-when of T-0.1.7)', () => {
  it('raises exactly one detection and one resync request', () => {
    const core = createStreamCore();
    const events = replay(core, gap);

    expect(events).toEqual([{ type: 'resync', reason: 'gap' }]);
    expect(core.stats().gaps).toBe(1);
    expect(core.status()).toBe('resync');
  });

  it('data after the detection is ignored until the next snapshot arrives', () => {
    const core = createStreamCore();
    replay(core, gap);
    const recordsAfterGap = core.stats().records;

    // More deltas from the torn stream: no double detection, no application.
    const stray = gap[gap.length - 1]!;
    expect(core.onMessage(encodeFrame(stray), stray.serverTs + 10)).toEqual([]);
    expect(core.stats().records).toBe(recordsAfterGap);

    // The snapshot of the reconnect restores service — same code as connect.
    const snapshot = normal[0]!;
    expect(core.onMessage(encodeFrame(snapshot), stray.serverTs + 20)).toEqual([]);
    expect(core.status()).toBe('live');
  });
});

describe('mid-stream snapshot', () => {
  it('replaces state wholesale and continues live with no false gap', () => {
    const core = createStreamCore();
    const events = replay(core, midstream);

    expect(events).toEqual([]);
    expect(core.status()).toBe('live');
    expect(core.stats().gaps).toBe(0);
    // Both snapshots counted, stream stayed dense across the replacement.
    expect(midstream.filter((f) => f.frameType === 'SNAPSHOT')).toHaveLength(2);
  });
});

describe('heartbeat silence (done-when of T-0.1.7)', () => {
  it('heartbeats keep the channel alive; true silence is declared dead within the threshold', () => {
    const core = createStreamCore();
    const events = replay(core, heartbeatSilence);
    expect(events).toEqual([]);
    expect(core.status()).toBe('live');
    expect(core.stats().heartbeats).toBe(4);

    const lastTs = heartbeatSilence[heartbeatSilence.length - 1]!.serverTs;
    expect(core.onTick(lastTs + DEAD_AFTER_MS - 1)).toEqual([]);
    expect(core.onTick(lastTs + DEAD_AFTER_MS + 1)).toEqual([{ type: 'resync', reason: 'silence' }]);
    expect(core.status()).toBe('resync');
    // The watchdog does not fire twice for the same death.
    expect(core.onTick(lastTs + DEAD_AFTER_MS + 500)).toEqual([]);
  });

  it('a heartbeat whose seq is ahead of the stream proves loss even in silence (§6.3)', () => {
    const core = createStreamCore();
    replay(core, heartbeatSilence);
    const lastSeq = core.stats().lastSeq!;

    const lying = heartbeatFrame(lastSeq + 10, 5000);
    expect(core.onMessage(encodeFrame(lying), 5000)).toEqual([{ type: 'resync', reason: 'heartbeat-loss' }]);
  });
});

describe('protocol damage', () => {
  it('malformed input raises one protocol-error resync', () => {
    const core = createStreamCore();
    replay(core, normal);
    expect(core.onMessage('not a frame', 2000)).toEqual([{ type: 'resync', reason: 'protocol-error' }]);
    expect(core.stats().protocolErrors).toBe(1);
    // Already resyncing: further garbage stays silent for the shell.
    expect(core.onMessage('still not a frame', 2001)).toEqual([]);
  });

  it('an unknown frame type is skipped silently — new types do not bump fx.v1', () => {
    const core = createStreamCore();
    replay(core, normal);
    const alien = JSON.stringify({ frameType: 'NEWS', count: 0, firstSeq: 0, serverTs: 0, records: [] });
    expect(core.onMessage(alien, 2000)).toEqual([]);
    expect(core.status()).toBe('live');
  });
});

describe('upsert idempotence (done-when of T-0.1.7)', () => {
  const record: WireRecord = { pairId: 1, side: 'bid', level: 2, price: 127001, size: 900, seq: 55 };

  it('applying the same record twice changes nothing', () => {
    const books = new Map<number, PairBook>();
    applyRecord(books, record);
    const once = structuredClone(books);
    applyRecord(books, record);
    expect(books).toEqual(once);
  });

  it('size 0 clears the level', () => {
    const books = new Map<number, PairBook>();
    applyRecord(books, record);
    applyRecord(books, { ...record, size: 0 });
    expect(books.get(1)!.bids[2]).toBeNull();
  });
});
