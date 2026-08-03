import { readFileSync } from 'node:fs';

import { assembleFrame, decodeFrame, encodeFrame } from '@fx/protocol';
import { createMarket } from '@fx/sim-core';

import { createFeedServer } from '../../apps/feed-server/src/server';
import type { FeedStreamHandle } from '../../apps/web/src/stream/connect';
import { createStreamCore } from '../../apps/web/src/stream/core';
import { createFeedStore } from '../../apps/web/src/stream/store';

// Perf gate v2 (T-0.2.8): both halves of AC-01. The server half feeds 50k
// updates/s to one real ws client and reads the tick p95 from /sim/stats.
// The client half replays the same firehose through the sans-I/O stream
// pipeline (architecture §11): injected frame scheduler, one flush per
// simulated 16 ms — the coalesced path must hold its p95 inside the 60 fps
// budget. The naive-vs-coalesced DOM contrast stays a deployed-panel demo;
// CI gates the pipeline it can measure honestly. Thresholds only ratchet up.

interface Thresholds {
  release: string;
  feedUpdatesPerSec: number;
  minReceivedUpdatesPerSec: number;
  maxP95TickMs: number;
  maxClientMessageP95Ms: number;
  maxClientFlushP95Ms: number;
}

const thresholdsPath = process.env['FX_GATE_THRESHOLDS'] ?? new URL('./thresholds.json', import.meta.url);
const thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf8')) as Thresholds;

const WARMUP_MS = 2000;
const MEASURE_MS = 8000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Server half: real server, real socket.
// ---------------------------------------------------------------------------

async function serverHalf(): Promise<{ received: number; bytesPerSec: number; tickP95: number }> {
  const server = createFeedServer({
    port: 0,
    allowedOrigins: [],
    heartbeatIntervalMs: 1000,
    tickMs: 8,
    seed: 42,
    updatesPerSec: thresholds.feedUpdatesPerSec,
    slowClientBufferBytes: 64_000_000, // the gate measures throughput, not the guard
    maxClients: 4,
    sessionCeilingMs: 60 * 60_000,
    simSecret: null,
  });
  const port = await server.listen();

  let measuring = false;
  let records = 0;
  let bytes = 0;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/feed`, 'fx.v1');
  ws.onmessage = (event: MessageEvent) => {
    if (!measuring) return;
    const text = String(event.data);
    bytes += text.length;
    const frame = decodeFrame(text);
    if (frame !== null) records += frame.count;
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('feed handshake failed'));
  });

  await sleep(WARMUP_MS);
  measuring = true;
  await sleep(MEASURE_MS);
  measuring = false;

  const stats = (await (await fetch(`http://127.0.0.1:${port}/sim/stats`)).json()) as {
    tick: { p95: number };
  };
  ws.close();
  await server.close();

  return {
    received: records / (MEASURE_MS / 1000),
    bytesPerSec: bytes / (MEASURE_MS / 1000),
    tickP95: stats.tick.p95,
  };
}

// ---------------------------------------------------------------------------
// Client half: the coalesced pipeline against the same firehose, no I/O.
// ---------------------------------------------------------------------------

function clientHalf(): { messageP95: number; flushP95: number; frames: number; sink: number } {
  const market = createMarket(42, thresholds.feedUpdatesPerSec);
  market.advance(0);
  const core = createStreamCore();
  let notify: () => void = () => undefined;
  const handle: FeedStreamHandle = {
    core,
    socketState: () => 'open',
    lastResync: () => null,
    lastClose: () => null,
    terminal: () => false,
    resume: () => undefined,
    close: () => undefined,
  };
  const frameQueue: Array<() => void> = [];
  const store = createFeedStore(
    (onChange) => {
      notify = onChange;
      return handle;
    },
    { scheduleFrame: (cb) => frameQueue.push(cb) },
  );

  // Approximate the render read: every flush walks the tops of all books, the
  // way the ladder's subscribed rows would.
  let sink = 0;
  store.subscribe(() => {
    for (const [, book] of core.books()) {
      sink += (book.bids[0]?.price ?? 0) + (book.asks[0]?.price ?? 0);
    }
  });

  let nextSeq = 0;
  const snap = assembleFrame('SNAPSHOT', market.snapshot(), nextSeq, 0);
  nextSeq = snap.nextSeq;
  core.onMessage(encodeFrame(snap.frame), 0);
  notify();

  // Five simulated seconds: 8 ms server ticks, one animation frame per 16 ms.
  for (let t = 16; t <= 5000; t += 16) {
    for (const half of [t - 8, t]) {
      const updates = market.advance(half);
      if (updates.length === 0) continue;
      const assembled = assembleFrame('DELTA', updates, nextSeq, half);
      nextSeq = assembled.nextSeq;
      core.onMessage(encodeFrame(assembled.frame), half);
      notify();
    }
    for (const cb of frameQueue.splice(0)) cb();
  }

  const stats = store.renderStats();
  return { messageP95: stats.messageP95, flushP95: stats.flushP95, frames: stats.messages, sink };
}

// ---------------------------------------------------------------------------

const server = await serverHalf();
const client = clientHalf();

const rows = [
  ['fed updates/s', thresholds.feedUpdatesPerSec.toFixed(0), ''],
  ['received updates/s', server.received.toFixed(0), `>= ${thresholds.minReceivedUpdatesPerSec}`],
  ['p95 server tick (ms)', server.tickP95.toFixed(3), `<= ${thresholds.maxP95TickMs}`],
  ['bytes/s (JSON baseline)', `${(server.bytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s`, 'recorded, not gated'],
  ['client msg p95 (ms)', client.messageP95.toFixed(3), `<= ${thresholds.maxClientMessageP95Ms}`],
  ['client flush p95 (ms)', client.flushP95.toFixed(3), `<= ${thresholds.maxClientFlushP95Ms} (60 fps budget)`],
  ['client frames replayed', String(client.frames), ''],
] as const;
console.log(
  `perf gate — thresholds ${thresholds.release}, server window ${MEASURE_MS / 1000}s after ${WARMUP_MS / 1000}s warmup, client replay 5 simulated seconds`,
);
for (const [name, value, bound] of rows) {
  console.log(`  ${name.padEnd(26)} ${String(value).padStart(14)}  ${bound}`);
}

const failures: string[] = [];
if (server.received < thresholds.minReceivedUpdatesPerSec) {
  failures.push(`received ${server.received.toFixed(0)} updates/s < ${thresholds.minReceivedUpdatesPerSec}`);
}
if (server.tickP95 > thresholds.maxP95TickMs) {
  failures.push(`server tick p95 ${server.tickP95.toFixed(3)} ms > ${thresholds.maxP95TickMs} ms`);
}
if (client.messageP95 > thresholds.maxClientMessageP95Ms) {
  failures.push(`client msg p95 ${client.messageP95.toFixed(3)} ms > ${thresholds.maxClientMessageP95Ms} ms`);
}
if (client.flushP95 > thresholds.maxClientFlushP95Ms) {
  failures.push(`client flush p95 ${client.flushP95.toFixed(3)} ms > ${thresholds.maxClientFlushP95Ms} ms`);
}

if (failures.length > 0) {
  console.error(`GATE RED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('GATE GREEN');
process.exit(0);
