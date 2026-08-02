import { readFileSync } from 'node:fs';

import { decodeFrame, encodeFrame, type Frame } from '@fx/protocol';
import { describe, expect, it } from 'vitest';

import { FIXTURES } from './build';

// Fixtures are regenerable, never hand-edited (T-0.1.9): a schema or model
// change without `pnpm fixtures` turns verify red.

function committed(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../packages/protocol/fixtures/${file}`, import.meta.url), 'utf8'));
}

describe('committed fixtures match the generators (run `pnpm fixtures` after model changes)', () => {
  it.each(FIXTURES.map((f) => [f.file, f.build] as const))('%s', (file, build) => {
    expect(committed(file)).toEqual(build());
  });

  it('every fixture frame passes the wire codec', () => {
    for (const { file, build } of FIXTURES) {
      for (const frame of build()) {
        // decodeFrame re-runs the envelope and density validation.
        expect(decodeFrame(encodeFrame(frame)), `${file}: frame at seq ${frame.firstSeq}`).not.toBeNull();
      }
    }
  });

  it('the gap fixture carries exactly one hole of 40', () => {
    const frames = FIXTURES.find((f) => f.file === 'gap-stream.json')!.build();
    const data = frames.filter((f: Frame) => f.frameType !== 'HEARTBEAT');
    const holes: number[] = [];
    for (let i = 1; i < data.length; i += 1) {
      const jump = data[i]!.firstSeq - (data[i - 1]!.firstSeq + data[i - 1]!.count);
      if (jump !== 0) holes.push(jump);
    }
    expect(holes).toEqual([40]);
  });
});
