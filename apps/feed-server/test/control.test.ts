import { decodeFrame, FX_SUBPROTOCOL, type Frame } from '@fx/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { FeedServerConfig } from '../src/config';
import { percentile, type SimStats } from '../src/control';
import { createFeedServer, type FeedServer } from '../src/server';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function testConfig(overrides: Partial<FeedServerConfig> = {}): FeedServerConfig {
  return {
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    heartbeatIntervalMs: 1000,
    tickMs: 10,
    seed: 42,
    updatesPerSec: 2000,
    ...overrides,
  };
}

const servers: FeedServer[] = [];
const sockets: WebSocket[] = [];

async function startServer(overrides: Partial<FeedServerConfig> = {}): Promise<number> {
  const server = createFeedServer(testConfig(overrides));
  servers.push(server);
  return server.listen();
}

function openFeed(port: number): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/feed`, [FX_SUBPROTOCOL], {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  sockets.push(ws);
  ws.on('message', (data) => {
    const frame = decodeFrame(String(data));
    if (frame !== null) frames.push(frame);
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function post(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getStats(port: number): Promise<SimStats> {
  const res = await fetch(`http://127.0.0.1:${port}/sim/stats`);
  return (await res.json()) as SimStats;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('validation at the border (done-when of T-0.1.6)', () => {
  it('an invalid body returns 400 with a field-level reason and never reaches the simulator', async () => {
    const port = await startServer();
    const before = await getStats(port);

    const res = await post(port, '/sim/rate', { updatesPerSec: 50_000 }); // over the v0.1 cap
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ path: string; message: string }> };
    expect(body.error).toBe('validation failed');
    expect(body.issues[0]!.path).toBe('updatesPerSec');
    expect(body.issues[0]!.message.length).toBeGreaterThan(0);

    expect((await getStats(port)).updatesPerSec).toBe(before.updatesPerSec);
  });

  it.each([
    ['/sim/seed', { seed: -1 }, 'seed'],
    ['/sim/seed', { seed: 1.5 }, 'seed'],
    ['/sim/gap', { skipSeqs: 0 }, 'skipSeqs'],
    ['/sim/gap', {}, 'skipSeqs'],
  ])('%s rejects %j naming the field', async (path, bad, field) => {
    const port = await startServer();
    const res = await post(port, path, bad);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: Array<{ path: string }> };
    expect(body.issues.some((issue) => issue.path.includes(field))).toBe(true);
  });

  it('malformed JSON, oversized bodies, wrong methods and unknown endpoints are refused', async () => {
    const port = await startServer();

    const raw = await fetch(`http://127.0.0.1:${port}/sim/seed`, { method: 'POST', body: 'not json' });
    expect(raw.status).toBe(400);

    const huge = await fetch(`http://127.0.0.1:${port}/sim/seed`, { method: 'POST', body: 'x'.repeat(20_000) });
    expect(huge.status).toBe(400);

    expect((await fetch(`http://127.0.0.1:${port}/sim/stats`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/sim/seed`)).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/sim/unknown`)).status).toBe(404);
  });
});

describe('/sim/gap', () => {
  it('produces exactly one hole of exactly skipSeqs on the wire', { timeout: 10_000 }, async () => {
    const port = await startServer();
    const { frames } = await openFeed(port);
    await settle(300);
    expect((await post(port, '/sim/gap', { skipSeqs: 40 })).status).toBe(200);
    await settle(300);

    const data = frames.filter((f) => f.frameType !== 'HEARTBEAT');
    const holes: number[] = [];
    for (let i = 1; i < data.length; i += 1) {
      const jump = data[i]!.firstSeq - (data[i - 1]!.firstSeq + data[i - 1]!.count);
      if (jump !== 0) holes.push(jump);
    }
    expect(holes).toEqual([40]);
  });
});

describe('/sim/seed', () => {
  it('two runs from the same seed are bit-identical record for record', { timeout: 10_000 }, async () => {
    const port = await startServer({ updatesPerSec: 500 });

    // Frame boundaries are transport timing; the contract is the record
    // stream: same (seed, commands) → prefixes of the same infinite stream,
    // seq included, since every fresh wire starts at 0 (§5.1, §6.2).
    async function capture(): Promise<unknown[]> {
      expect((await post(port, '/sim/seed', { seed: 7 })).status).toBe(200);
      const { ws, frames } = await openFeed(port);
      await settle(500);
      ws.terminate();
      return frames.filter((f) => f.frameType !== 'HEARTBEAT').flatMap((f) => f.records);
    }

    const a = await capture();
    const b = await capture();
    const prefix = Math.min(a.length, b.length);
    expect(prefix).toBeGreaterThan(100);
    expect(b.slice(0, prefix)).toEqual(a.slice(0, prefix));
  });

  it('reseeding mid-stream pushes every client a dense snapshot', { timeout: 10_000 }, async () => {
    const port = await startServer();
    const { frames } = await openFeed(port);
    await settle(200);
    expect((await post(port, '/sim/seed', { seed: 99 })).status).toBe(200);
    await settle(300);

    const snapshots = frames.filter((f) => f.frameType === 'SNAPSHOT');
    expect(snapshots.length).toBe(2); // connect + reseed
    const data = frames.filter((f) => f.frameType !== 'HEARTBEAT');
    for (let i = 1; i < data.length; i += 1) {
      expect(data[i]!.firstSeq).toBe(data[i - 1]!.firstSeq + data[i - 1]!.count);
    }
  });
});

describe('/sim/stats', () => {
  it('reports a non-zero p95 tick duration and moving counters under load', { timeout: 10_000 }, async () => {
    const port = await startServer({ updatesPerSec: 5000 });
    const { frames } = await openFeed(port);
    await settle(700);

    const stats = await getStats(port);
    expect(stats.clients).toBe(1);
    expect(stats.updatesPerSec).toBe(5000);
    expect(stats.generated).toBeGreaterThan(0);
    expect(stats.sent).toBeGreaterThan(0);
    expect(stats.sent).toBeGreaterThanOrEqual(frames.filter((f) => f.frameType === 'DELTA').length);
    expect(stats.tick.samples).toBeGreaterThan(0);
    expect(stats.tick.p95).toBeGreaterThan(0);
    expect(stats.tick.max).toBeGreaterThanOrEqual(stats.tick.p95);
  });

  it('rate changes via /sim/rate are visible in stats and on the wire', { timeout: 10_000 }, async () => {
    const port = await startServer({ updatesPerSec: 100 });
    expect((await post(port, '/sim/rate', { updatesPerSec: 4000 })).status).toBe(200);
    const { frames } = await openFeed(port);
    await settle(500);

    expect((await getStats(port)).updatesPerSec).toBe(4000);
    const deltas = frames.filter((f) => f.frameType === 'DELTA');
    const records = deltas.reduce((sum, f) => sum + f.count, 0);
    expect(records).toBeGreaterThan(1000); // ~2000 expected at 4000/s over 0.5 s
  });
});

describe('/sim/news', () => {
  it('the shock reaches the wire: first refreshed top-of-book carries the widened spread', { timeout: 10_000 }, async () => {
    const port = await startServer({ updatesPerSec: 100 });
    const { frames } = await openFeed(port);
    await settle(150);
    const framesBefore = frames.length;

    expect((await post(port, '/sim/news', { pair: 'GBPUSD', pips: 80, spreadX: 6 })).status).toBe(200);
    await settle(250);

    const after = frames.slice(framesBefore).flatMap((f) => f.records);
    const bid = after.find((r) => r.pairId === 1 && r.side === 'bid' && r.level === 0);
    const ask = after.find((r) => r.pairId === 1 && r.side === 'ask' && r.level === 0);
    // GBPUSD base spread is 9 pipettes; the refresh lands at the full ×6.
    expect(ask!.price - bid!.price).toBe(54);
  });

  it('unknown pair is a field-level 400 that never reaches the simulator', async () => {
    const port = await startServer();
    const res = await post(port, '/sim/news', { pair: 'XXXYYY', pips: 10, spreadX: 2 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: Array<{ path: string; message: string }> };
    expect(body.issues[0]!.path).toBe('pair');
    expect(body.issues[0]!.message).toContain('unknown');
  });

  it.each([
    [{ pair: 'GBPUSD', pips: 0, spreadX: 2 }, 'pips'],
    [{ pair: 'GBPUSD', pips: 10, spreadX: 0.5 }, 'spreadX'],
    [{ pair: 'gbpusd', pips: 10, spreadX: 2 }, 'pair'],
  ])('rejects %j naming %s', async (bad, field) => {
    const port = await startServer();
    const res = await post(port, '/sim/news', bad);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: Array<{ path: string }> };
    expect(body.issues.some((issue) => issue.path.includes(field))).toBe(true);
  });
});

describe('CORS preflight (the docs page posts cross-origin)', () => {
  it('answers OPTIONS with the method/header grant for an allowed origin', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/sim/rate`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('grants nothing to a foreign origin', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/sim/rate`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('percentile', () => {
  it('nearest-rank on small sets, 0 on empty', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
  });
});
