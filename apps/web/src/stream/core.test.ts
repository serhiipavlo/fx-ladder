import { INSTRUMENTS } from '@fx/domain';
import gapJson from '@fx/protocol/fixtures/gap-stream.json';
import heartbeatJson from '@fx/protocol/fixtures/heartbeat-silence.json';
import midstreamJson from '@fx/protocol/fixtures/midstream-snapshot.json';
import normalJson from '@fx/protocol/fixtures/normal-stream.json';
import { encodeFrame, encodeFrameBinary, heartbeatFrame, type Frame, type WireRecord } from '@fx/protocol';
import { describe, expect, it } from 'vitest';

import { applyRecord, createStreamCore, DEAD_AFTER_MS, type PairBook, type StreamEvent } from './core';

const normal = normalJson as unknown as Frame[];
const gap = gapJson as unknown as Frame[];
const midstream = midstreamJson as unknown as Frame[];
const heartbeatSilence = heartbeatJson as unknown as Frame[];

/** Replays fixture frames through the full decode path, clock = serverTs. */
const replay = (core: ReturnType<typeof createStreamCore>, frames: Frame[]): StreamEvent[] =>
  frames.flatMap((frame) => core.onMessage(encodeFrame(frame), frame.serverTs));

describe('normal stream', () => {
  it('goes live, builds all five books, keeps bid < ask', () => {
    const core = createStreamCore();
    const events = replay(core, normal);

    expect(events).toEqual([]);
    expect(core.status()).toBe('live');
    expect(core.books().size).toBe(INSTRUMENTS.length);
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

describe('the binary wire through the same core (ADR-12)', () => {
  it('fx.v2 fixtures replay to the same books, density and gap arithmetic as fx.v1', () => {
    const v1 = createStreamCore();
    replay(v1, normal);
    const v2 = createStreamCore();
    for (const frame of normal) v2.onMessage(encodeFrameBinary(frame), frame.serverTs);

    expect(v2.status()).toBe('live');
    expect(v2.stats().gaps).toBe(0);
    expect(v2.stats().records).toBe(v1.stats().records);
    expect(v2.stats().lastSeq).toBe(v1.stats().lastSeq);
    expect([...v2.books().entries()]).toEqual([...v1.books().entries()]); // one story, two wires
    // The whole point, in one inequality: the same stream cost far fewer bytes.
    expect(v2.stats().wireBytes).toBeLessThan(v1.stats().wireBytes / 4);
  });

  it('a hole across binary frames is still proven loss', () => {
    const core = createStreamCore();
    core.onMessage(encodeFrameBinary(normal[0]!), 1);
    const torn = { ...normal[1]!, firstSeq: normal[1]!.firstSeq + 40 };
    torn.records = torn.records.map((r, i) => ({ ...r, seq: torn.firstSeq + i }));
    const events = core.onMessage(encodeFrameBinary(torn), 2);
    expect(events).toEqual([{ type: 'resync', reason: 'gap' }]);
  });

  it('binary damage is loud: protocol-error resync, like malformed JSON', () => {
    const core = createStreamCore();
    core.onMessage(encodeFrameBinary(normal[0]!), 1);
    const damaged = new Uint8Array(encodeFrameBinary(normal[1]!).slice(0, 20));
    const events = core.onMessage(damaged.buffer, 2);
    expect(events).toEqual([{ type: 'resync', reason: 'protocol-error' }]);
  });

  it('the byte meter counts the trailing second, on either wire', () => {
    const core = createStreamCore();
    const first = encodeFrameBinary(normal[0]!);
    const second = encodeFrameBinary(normal[1]!);
    core.onMessage(first, 100);
    core.onMessage(second, 500);
    expect(core.stats().wireBytes).toBe(first.byteLength + second.byteLength);
    expect(core.bytesPerSec(600)).toBe(first.byteLength + second.byteLength);
    expect(core.bytesPerSec(1400)).toBe(second.byteLength); // the first fell out of the window
  });

  it('the meter survives its own compaction: a long busy stream still reports one second', () => {
    const core = createStreamCore();
    const frame = encodeFrameBinary(normal[0]!);
    // 400 messages 10ms apart — four seconds of traffic, so the window expires
    // far more samples than it keeps and the meter compacts underneath.
    for (let i = 0; i < 400; i += 1) core.onMessage(frame, i * 10);

    expect(core.stats().wireBytes).toBe(frame.byteLength * 400); // cumulative: everything
    // Trailing second at t=3990: the samples at 2_990…3_990 inclusive, 101 of them.
    expect(core.bytesPerSec(3990)).toBe(frame.byteLength * 101);
    expect(core.bytesPerSec(10_000)).toBe(0); // silence expires the window entirely
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
