import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleFrame,
  decodeFrame,
  encodeFrame,
  FX_SUBPROTOCOL,
  heartbeatFrame,
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

function update(): LevelUpdate {
  return { pairId: 0, side: 'bid', level: 0, price: 108500, size: 1000 };
}
