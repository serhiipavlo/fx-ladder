import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleFrame,
  decodeFrame,
  decodeFrameBinary,
  encodeFrame,
  encodeFrameBinary,
  FX_SUBPROTOCOL,
  FX_SUBPROTOCOL_V2,
  heartbeatFrame,
  PREFERRED_SUBPROTOCOLS,
  type LevelUpdate,
} from './frames';

const levelUpdateArb: fc.Arbitrary<LevelUpdate> = fc.record({
  pairId: fc.integer({ min: 0, max: 4 }),
  side: fc.constantFrom<'bid' | 'ask'>('bid', 'ask'),
  level: fc.integer({ min: 0, max: 3 }),
  price: fc.integer({ min: 1, max: 200_000 }),
  size: fc.integer({ min: 0, max: 5000 }),
});

const framePartsArb = fc.record({
  frameType: fc.constantFrom<'SNAPSHOT' | 'DELTA'>('SNAPSHOT', 'DELTA'),
  updates: fc.array(levelUpdateArb, { maxLength: 200 }),
  firstSeq: fc.integer({ min: 0, max: 2 ** 40 }),
  serverTs: fc.integer({ min: 0, max: 2 ** 40 }),
});

describe('roundtrip fuzz (done-when of T-0.1.4)', () => {
  it('encode → decode returns the assembled frame, for any generated frame', () => {
    fc.assert(
      fc.property(framePartsArb, ({ frameType, updates, firstSeq, serverTs }) => {
        const { frame } = assembleFrame(frameType, updates, firstSeq, serverTs);
        expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
      }),
    );
  });

  it('heartbeats roundtrip too', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), fc.integer({ min: 0, max: 2 ** 40 }), (lastSeq, ts) => {
        const frame = heartbeatFrame(lastSeq, ts);
        expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
        expect(frame.count).toBe(0);
        expect(frame.records).toEqual([]);
      }),
    );
  });
});

describe('dense seq — the gap detector rests on this (§6.2)', () => {
  it('assembling N records yields firstSeq…firstSeq+N-1 with no holes and the right nextSeq', () => {
    fc.assert(
      fc.property(framePartsArb, ({ frameType, updates, firstSeq, serverTs }) => {
        const { frame, nextSeq } = assembleFrame(frameType, updates, firstSeq, serverTs);
        expect(frame.count).toBe(updates.length);
        expect(nextSeq).toBe(firstSeq + updates.length);
        frame.records.forEach((record, i) => {
          expect(record.seq).toBe(firstSeq + i);
        });
      }),
    );
  });

  it('decode rejects a frame whose seqs are not dense', () => {
    const { frame } = assembleFrame('DELTA', [update(), update(), update()], 100, 5);
    frame.records[1]!.seq = 105;
    expect(() => decodeFrame(encodeFrame(frame))).toThrow(/dense/);
  });

  it('decode rejects a count that disagrees with the records', () => {
    const { frame } = assembleFrame('DELTA', [update()], 0, 0);
    expect(() => decodeFrame(JSON.stringify({ ...frame, count: 2 }))).toThrow(/count/);
  });
});

describe('malformed input is loud, unknown frame types are silent', () => {
  it.each([
    'not json',
    '42',
    '{}',
    '{"frameType":"DELTA","count":0,"firstSeq":0,"serverTs":0}',
    '{"frameType":"DELTA","count":0,"firstSeq":-1,"serverTs":0,"records":[]}',
    '{"frameType":"DELTA","count":0,"firstSeq":0,"serverTs":0,"records":[],"extra":1}',
  ])('throws on %j', (bad) => {
    expect(() => decodeFrame(bad)).toThrow();
  });

  it('rejects records with an unknown side, zero price or fractional fields', () => {
    const base = { pairId: 0, level: 0, price: 100, size: 10, seq: 0 };
    for (const record of [
      { ...base, side: 'mid' },
      { ...base, side: 'bid', price: 0 },
      { ...base, side: 'bid', price: 100.5 },
    ]) {
      const text = JSON.stringify({ frameType: 'DELTA', count: 1, firstSeq: 0, serverTs: 0, records: [record] });
      expect(() => decodeFrame(text)).toThrow();
    }
  });

  it('returns null for a well-formed frame of an unknown type — new types do not bump fx.v1 (§6.1)', () => {
    const text = JSON.stringify({ frameType: 'NEWS', count: 0, firstSeq: 7, serverTs: 3, records: [] });
    expect(decodeFrame(text)).toBeNull();
  });
});

it('negotiates protocol v1', () => {
  expect(FX_SUBPROTOCOL).toBe('fx.v1');
});

it('offers the binary wire first, the JSON wire as the fallback (ADR-12)', () => {
  expect(FX_SUBPROTOCOL_V2).toBe('fx.v2');
  expect(PREFERRED_SUBPROTOCOLS).toEqual(['fx.v2', 'fx.v1']);
});

describe('the binary wire — fx.v2 (ADR-12)', () => {
  // The v2 header carries firstSeq as u32 and count as u16: real bounds of
  // the real wire (per-connection seq resets at 0; 30 min × 50k/s ≈ 90M).
  const binaryPartsArb = fc.record({
    frameType: fc.constantFrom<'SNAPSHOT' | 'DELTA'>('SNAPSHOT', 'DELTA'),
    updates: fc.array(levelUpdateArb, { maxLength: 200 }),
    firstSeq: fc.integer({ min: 0, max: 0xffff_ffff - 200 }),
    serverTs: fc.integer({ min: 0, max: 2 ** 40 }),
  });

  it('binary encode → decode returns the assembled frame, for any generated frame', () => {
    fc.assert(
      fc.property(binaryPartsArb, ({ frameType, updates, firstSeq, serverTs }) => {
        const { frame } = assembleFrame(frameType, updates, firstSeq, serverTs);
        expect(decodeFrameBinary(encodeFrameBinary(frame))).toEqual(frame);
      }),
    );
  });

  it('both codecs tell one story: decode(encode) agrees across wires', () => {
    fc.assert(
      fc.property(binaryPartsArb, ({ frameType, updates, firstSeq, serverTs }) => {
        const { frame } = assembleFrame(frameType, updates, firstSeq, serverTs);
        expect(decodeFrameBinary(encodeFrameBinary(frame))).toEqual(decodeFrame(encodeFrame(frame)));
      }),
    );
  });

  it('heartbeats ride v2 too, 16 bytes flat', () => {
    const frame = heartbeatFrame(4242, 999);
    const bytes = encodeFrameBinary(frame);
    expect(bytes.byteLength).toBe(16);
    expect(decodeFrameBinary(bytes)).toEqual(frame);
  });

  it('a frame costs 16 + 12·count bytes — the arithmetic the README quotes', () => {
    const { frame } = assembleFrame('DELTA', [update(), update(), update()], 0, 1);
    expect(encodeFrameBinary(frame).byteLength).toBe(16 + 3 * 12);
  });

  it('golden bytes: the layout cannot drift silently', () => {
    const { frame } = assembleFrame('DELTA', [update()], 7, 3);
    const bytes = new Uint8Array(encodeFrameBinary(frame));
    expect([...bytes]).toEqual([
      2, 1, 1, 0, // version 2 · DELTA · count 1 (LE)
      7, 0, 0, 0, // firstSeq 7 (LE u32)
      0, 0, 0, 0, 0, 0, 8, 64, // serverTs 3.0 (LE f64)
      0, 0, 0, 0, // pairId 0 · bid · level 0 · reserved
      212, 167, 1, 0, // price 108500 (LE i32)
      232, 3, 0, 0, // size 1000 (LE u32)
    ]);
  });

  it('per-record seq is not on the wire: density is reconstructed, not trusted (§6.2)', () => {
    const { frame } = assembleFrame('DELTA', [update(), update()], 41, 1);
    const decoded = decodeFrameBinary(encodeFrameBinary(frame))!;
    expect(decoded.records.map((r) => r.seq)).toEqual([41, 42]);
  });

  it('structural damage is loud: version, truncation, length-count disagreement, nonsense side', () => {
    const { frame } = assembleFrame('DELTA', [update()], 0, 0);
    const good = encodeFrameBinary(frame);

    const badVersion = new Uint8Array(good.slice(0));
    badVersion[0] = 1;
    expect(() => decodeFrameBinary(badVersion.buffer)).toThrow(/version/);

    expect(() => decodeFrameBinary(good.slice(0, 8))).toThrow(/header/);
    expect(() => decodeFrameBinary(good.slice(0, 20))).toThrow(/count/);

    const badSide = new Uint8Array(good.slice(0));
    badSide[16 + 1] = 9;
    expect(() => decodeFrameBinary(badSide.buffer)).toThrow(/side/);
  });

  it('returns null for a well-formed frame of an unknown type code — same forward-compat rule as v1', () => {
    const bytes = new Uint8Array(encodeFrameBinary(heartbeatFrame(0, 0)));
    bytes[1] = 7; // a frame type this decoder has never heard of
    expect(decodeFrameBinary(bytes.buffer)).toBeNull();
  });

  it('the encoder refuses what the wire cannot carry — no silent truncation', () => {
    const { frame: bigSeq } = assembleFrame('DELTA', [], 0x1_0000_0000, 0);
    expect(() => encodeFrameBinary(bigSeq)).toThrow(/firstSeq/);

    const { frame: bigPair } = assembleFrame('DELTA', [{ ...update(), pairId: 300 }], 0, 0);
    expect(() => encodeFrameBinary(bigPair)).toThrow(/pairId/);
  });
});

function update(): LevelUpdate {
  return { pairId: 0, side: 'bid', level: 0, price: 108500, size: 1000 };
}
