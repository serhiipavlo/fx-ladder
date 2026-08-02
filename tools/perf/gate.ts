import { readFileSync } from 'node:fs';

import { decodeFrame } from '@fx/protocol';

import { createFeedServer } from '../../apps/feed-server/src/server';

// Perf gate v1 (T-0.1.11): feed 5k updates/s to one real client, measure what
// arrives and what the server's tick cost, compare against the versioned
// thresholds next to this script. Thresholds only ratchet up (plan §4);
// lowering one requires an ADR. CI values carry headroom — shared runners
// are noisy; honest numbers are measured on the reference machine.

interface Thresholds {
  release: string;
  feedUpdatesPerSec: number;
  minReceivedUpdatesPerSec: number;
  maxP95TickMs: number;
}

const thresholdsPath = process.env['FX_GATE_THRESHOLDS'] ?? new URL('./thresholds.json', import.meta.url);
const thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf8')) as Thresholds;

const WARMUP_MS = 2000;
const MEASURE_MS = 8000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const server = createFeedServer({
  port: 0,
  allowedOrigins: [],
  heartbeatIntervalMs: 1000,
  tickMs: 8,
  seed: 42,
  updatesPerSec: thresholds.feedUpdatesPerSec,
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
  tick: { p50: number; p95: number; p99: number; samples: number };
};
ws.close();
await server.close();

const received = records / (MEASURE_MS / 1000);
const bytesPerSec = bytes / (MEASURE_MS / 1000);

const rows = [
  ['fed updates/s', thresholds.feedUpdatesPerSec.toFixed(0), ''],
  ['received updates/s', received.toFixed(0), `>= ${thresholds.minReceivedUpdatesPerSec}`],
  ['p95 tick (ms)', stats.tick.p95.toFixed(3), `<= ${thresholds.maxP95TickMs}`],
  ['p50 / p99 tick (ms)', `${stats.tick.p50.toFixed(3)} / ${stats.tick.p99.toFixed(3)}`, ''],
  ['bytes/s (JSON baseline)', `${(bytesPerSec / 1024).toFixed(1)} KiB/s`, 'recorded, not gated'],
] as const;
console.log(`perf gate — thresholds ${thresholds.release}, window ${MEASURE_MS / 1000}s after ${WARMUP_MS / 1000}s warmup`);
for (const [name, value, bound] of rows) {
  console.log(`  ${name.padEnd(26)} ${String(value).padStart(14)}  ${bound}`);
}

const failures: string[] = [];
if (received < thresholds.minReceivedUpdatesPerSec) {
  failures.push(`received ${received.toFixed(0)} updates/s < ${thresholds.minReceivedUpdatesPerSec}`);
}
if (stats.tick.p95 > thresholds.maxP95TickMs) {
  failures.push(`p95 tick ${stats.tick.p95.toFixed(3)} ms > ${thresholds.maxP95TickMs} ms`);
}

if (failures.length > 0) {
  console.error(`GATE RED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('GATE GREEN');
process.exit(0);
