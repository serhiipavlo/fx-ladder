import { expect, it } from 'vitest';

import { encodeFrame, FX_SUBPROTOCOL, heartbeatFrame } from './index';

it('negotiates protocol v1', () => {
  expect(FX_SUBPROTOCOL).toBe('fx.v1');
});

it('heartbeat frame survives an encode → parse roundtrip', () => {
  const frame = heartbeatFrame(42, 1000);
  expect(JSON.parse(encodeFrame(frame))).toEqual({
    frameType: 'HEARTBEAT',
    count: 0,
    firstSeq: 42,
    serverTs: 1000,
  });
});
