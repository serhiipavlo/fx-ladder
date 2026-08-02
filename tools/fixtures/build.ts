import { assembleFrame, heartbeatFrame, type Frame, type LevelUpdate } from '@fx/protocol';
import { createMarket, type Market } from '@fx/sim-core';

// Builders for the recorded frame sequences under packages/protocol/fixtures
// (T-0.1.9). Everything grows deterministically from one seed and a fixed
// now-sequence — regenerable with `pnpm fixtures`, never hand-edited. The
// client stream layer's unit tests replay these files; later they feed the
// replay harness of the perf gate (architecture §11).

const SEED = 42;
const RATE = 500;
const TICK_MS = 50;

interface Wire {
  nextSeq: number;
  frames: Frame[];
}

function push(wire: Wire, frameType: 'SNAPSHOT' | 'DELTA', updates: readonly LevelUpdate[], serverTs: number): void {
  const { frame, nextSeq } = assembleFrame(frameType, updates, wire.nextSeq, serverTs);
  wire.frames.push(frame);
  wire.nextSeq = nextSeq;
}

function openWire(market: Market): Wire {
  market.advance(0);
  const wire: Wire = { nextSeq: 0, frames: [] };
  push(wire, 'SNAPSHOT', market.snapshot(), 0);
  return wire;
}

function stream(market: Market, wire: Wire, fromMs: number, toMs: number): void {
  for (let t = fromMs; t <= toMs; t += TICK_MS) {
    const updates = market.advance(t);
    if (updates.length > 0) push(wire, 'DELTA', updates, t);
  }
}

/** Snapshot, then one second of clean deltas. */
export function buildNormalStream(): Frame[] {
  const market = createMarket(SEED, RATE);
  const wire = openWire(market);
  stream(market, wire, TICK_MS, 1000);
  return wire.frames;
}

/** Same stream, but 40 seqs vanish mid-flight — the /sim/gap shape (NFR-08). */
export function buildGapStream(): Frame[] {
  const market = createMarket(SEED, RATE);
  const wire = openWire(market);
  stream(market, wire, TICK_MS, 500);
  wire.nextSeq += 40;
  stream(market, wire, 550, 1000);
  return wire.frames;
}

/** Deltas, then a mid-stream SNAPSHOT (the reseed shape) continuing the same dense wire. */
export function buildMidstreamSnapshot(): Frame[] {
  const market = createMarket(SEED, RATE);
  const wire = openWire(market);
  stream(market, wire, TICK_MS, 500);
  const reseeded = createMarket(7, RATE);
  reseeded.advance(500);
  push(wire, 'SNAPSHOT', reseeded.snapshot(), 500);
  stream(reseeded, wire, 550, 1000);
  return wire.frames;
}

/** A short burst, then only heartbeats: the channel is alive, the market is quiet (§6.3). */
export function buildHeartbeatSilence(): Frame[] {
  const market = createMarket(SEED, RATE);
  const wire = openWire(market);
  stream(market, wire, TICK_MS, 150);
  for (let t = 1000; t <= 4000; t += 1000) {
    wire.frames.push(heartbeatFrame(wire.nextSeq - 1, t));
  }
  return wire.frames;
}

export const FIXTURES: ReadonlyArray<{ file: string; build: () => Frame[] }> = [
  { file: 'normal-stream.json', build: buildNormalStream },
  { file: 'gap-stream.json', build: buildGapStream },
  { file: 'midstream-snapshot.json', build: buildMidstreamSnapshot },
  { file: 'heartbeat-silence.json', build: buildHeartbeatSilence },
];
