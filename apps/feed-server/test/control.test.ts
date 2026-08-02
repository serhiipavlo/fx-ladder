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
    slowClientBufferBytes: 1_000_000,
    maxClients: 20,
    sessionCeilingMs: 30 * 60_000,
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

    const res = await post(port, '/sim/rate', { updatesPerSec: 500_000 }); // over the v0.2 cap
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

describe('/sim/mode (done-when of T-0.2.4)', () => {
  it('batch:false produces one frame per update; batch:true restores tick frames', { timeout: 10_000 }, async () => {
    const port = await startServer({ updatesPerSec: 200 });
    expect((await post(port, '/sim/mode', { batch: false })).status).toBe(200);
    const { frames } = await openFeed(port);
    await settle(500);

    const deltas = frames.filter((f) => f.frameType === 'DELTA');
    expect(deltas.length).toBeGreaterThan(30);
    // Every unbatched frame carries exactly one record: frames ≈ updates.
    expect(deltas.every((f) => f.count === 1)).toBe(true);

    const before = frames.length;
    expect((await post(port, '/sim/mode', { batch: true })).status).toBe(200);
    await settle(500);
    const rebatched = frames.slice(before).filter((f) => f.frameType === 'DELTA');
    expect(rebatched.some((f) => f.count > 1)).toBe(true);
    expect((await getStats(port)).batch).toBe(true);
  });

  it('rejects a missing flag', async () => {
    const port = await startServer();
    expect((await post(port, '/sim/mode', {})).status).toBe(400);
  });
});

describe('/sim/freeze (done-when of T-0.2.4)', () => {
  it('stops one pair on the wire while the rest keep flowing, then the pair returns', { timeout: 10_000 }, async () => {
    const port = await startServer({ updatesPerSec: 4000 });
    const { frames } = await openFeed(port);
    await settle(150);
    const framesBefore = frames.length;

    expect((await post(port, '/sim/freeze', { pair: 'USDJPY', ms: 800 })).status).toBe(200);
    await settle(500); // inside the freeze window

    const during = frames.slice(framesBefore + 1).flatMap((f) => f.records);
    expect(during.length).toBeGreaterThan(500); // the channel is provably alive
    expect(during.some((r) => r.pairId === 2)).toBe(false); // USDJPY silent

    await settle(700); // past the window
    const after = frames.flatMap((f) => f.records);
    expect(after.some((r) => r.pairId === 2)).toBe(true); // woke up again
  });

  it('unknown pair is a field-level 400', async () => {
    const port = await startServer();
    const res = await post(port, '/sim/freeze', { pair: 'ZZZZZZ', ms: 500 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: Array<{ path: string }> };
    expect(body.issues[0]!.path).toBe('pair');
  });
});

describe('/sim/disconnect (done-when of T-0.2.2)', () => {
  it('graceful drops every client with 1000 — the deliberate goodbye', { timeout: 10_000 }, async () => {
    const port = await startServer();
    const { ws: a } = await openFeed(port);
    const { ws: b } = await openFeed(port);
    const codes = Promise.all([
      new Promise<number>((resolve) => a.on('close', resolve)),
      new Promise<number>((resolve) => b.on('close', resolve)),
    ]);
    expect((await post(port, '/sim/disconnect', { graceful: true })).status).toBe(200);
    expect(await codes).toEqual([1000, 1000]);
  });

  it('hard is a simulated crash: close 4000', { timeout: 10_000 }, async () => {
    const port = await startServer();
    const { ws } = await openFeed(port);
    const code = new Promise<number>((resolve) => ws.on('close', resolve));
    expect((await post(port, '/sim/disconnect', { graceful: false })).status).toBe(200);
    expect(await code).toBe(4000);
  });

  it('afterMs delays the drop', { timeout: 10_000 }, async () => {
    const port = await startServer();
    const { ws } = await openFeed(port);
    const started = Date.now();
    const code = new Promise<number>((resolve) => ws.on('close', resolve));
    expect((await post(port, '/sim/disconnect', { graceful: false, afterMs: 400 })).status).toBe(200);
    expect(await code).toBe(4000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('rejects malformed bodies at the border', async () => {
    const port = await startServer();
    expect((await post(port, '/sim/disconnect', {})).status).toBe(400);
    expect((await post(port, '/sim/disconnect', { graceful: false, afterMs: -5 })).status).toBe(400);
  });
});

describe('/sim/order and /sim/lastlook (done-when of T-0.3.3, T-0.3.5, T-0.3.6)', () => {
  it('a burst moves fills, partials and rejects; raising rejectRate shifts the mix', { timeout: 15_000 }, async () => {
    const port = await startServer({ updatesPerSec: 500 });

    for (let i = 0; i < 12; i += 1) {
      const res = await post(port, '/sim/order', {
        pair: 'EURUSD',
        side: i % 2 === 0 ? 'buy' : 'sell',
        qtyK: 400,
        tif: 'IOC',
      });
      expect(res.status).toBe(200);
    }
    await settle(1500); // scripts play out: hold 40 ms + up to 3 fills at 120 ms
    const first = (await getStats(port)).executions;
    expect(first.submitted).toBe(12);
    expect(first.filled + first.canceled).toBe(12);
    expect(first.trades).toBeGreaterThan(0);
    expect(first.partials).toBeGreaterThan(0);
    expect(first.rejected).toBe(0);

    expect((await post(port, '/sim/lastlook', { holdMs: 60, rejectRate: 1 })).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      const res = await post(port, '/sim/order', { pair: 'GBPUSD', side: 'buy', qtyK: 100 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { immediate: unknown[] };
      expect(body.immediate).toHaveLength(0); // held, not answered yet
    }
    await settle(600);
    const second = (await getStats(port)).executions;
    expect(second.rejected).toBe(5); // every held order bounced with LAST_LOOK
    expect(second.lastLook).toEqual({ holdMs: 60, rejectRate: 1 });
  });

  it('a frozen pair rejects with STALE_PRICE even though the client believed the price fresh', async () => {
    const port = await startServer();
    // The race, constructed exactly (§7.3): the world changes after the
    // client's last look at the price and before the order lands.
    expect((await post(port, '/sim/freeze', { pair: 'USDJPY', ms: 5000 })).status).toBe(200);
    const res = await post(port, '/sim/order', { pair: 'USDJPY', side: 'buy', qtyK: 100 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clOrdId: string; immediate: Array<{ execType: string; rejectReason: string }> };
    expect(body.immediate).toHaveLength(1);
    expect(body.immediate[0]!.execType).toBe('REJECTED');
    expect(body.immediate[0]!.rejectReason).toBe('STALE_PRICE');
  });

  it('unknown pair, duplicate clOrdId and malformed bodies are field-level 400s', async () => {
    const port = await startServer();
    const unknown = await post(port, '/sim/order', { pair: 'ZZZZZZ', side: 'buy', qtyK: 10 });
    expect(unknown.status).toBe(400);

    expect((await post(port, '/sim/order', { clOrdId: 'DUP', pair: 'EURUSD', side: 'buy', qtyK: 10 })).status).toBe(200);
    const dup = await post(port, '/sim/order', { clOrdId: 'DUP', pair: 'EURUSD', side: 'sell', qtyK: 10 });
    expect(dup.status).toBe(400);
    const dupBody = (await dup.json()) as { issues: Array<{ path: string }> };
    expect(dupBody.issues[0]!.path).toBe('clOrdId');

    expect((await post(port, '/sim/order', { pair: 'EURUSD', side: 'hold', qtyK: 10 })).status).toBe(400);
    expect((await post(port, '/sim/lastlook', { holdMs: -1, rejectRate: 0 })).status).toBe(400);
    expect((await post(port, '/sim/lastlook', { holdMs: 10, rejectRate: 2 })).status).toBe(400);
  });
});

describe('/sim/blotter (done-when of T-0.4.6, server half)', () => {
  it('a burst fills the books through the real submit path', { timeout: 15_000 }, async () => {
    const port = await startServer({ updatesPerSec: 500 });
    const res = await post(port, '/sim/blotter', { rows: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submitted: 40 });

    await settle(1500); // scripts play out: hold 40 ms + up to 3 fills at 120 ms
    const stats = (await getStats(port)).executions;
    expect(stats.submitted).toBe(40);
    expect(stats.filled + stats.canceled).toBe(40); // qty is always valid, nothing frozen
    expect(stats.trades).toBeGreaterThan(0);
  });

  it('reseed → identical burst: composition and outcomes are deterministic', { timeout: 15_000 }, async () => {
    const port = await startServer({ updatesPerSec: 500 });

    async function capture(): Promise<unknown> {
      expect((await post(port, '/sim/seed', { seed: 7 })).status).toBe(200);
      expect((await post(port, '/sim/blotter', { rows: 30 })).status).toBe(200);
      await settle(1500);
      return (await getStats(port)).executions;
    }

    // Reseed resets all three PRNG streams (market, engine, blotter): the
    // same seed replays the same burst — fills, partials, cancels and all.
    expect(await capture()).toEqual(await capture());
  });

  it('the live-order ceiling refuses a burst on top of a full book, naming the field', { timeout: 15_000 }, async () => {
    const port = await startServer();
    // Hold every order at last look for 10 s: all of them stay live.
    expect((await post(port, '/sim/lastlook', { holdMs: 10_000, rejectRate: 0 })).status).toBe(200);
    expect((await post(port, '/sim/blotter', { rows: 5000 })).status).toBe(200);
    expect((await post(port, '/sim/blotter', { rows: 5000 })).status).toBe(200);

    const refused = await post(port, '/sim/blotter', { rows: 1 });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { issues: Array<{ path: string; message: string }> };
    expect(body.issues[0]!.path).toBe('rows');
    expect(body.issues[0]!.message).toContain('live orders');

    expect((await post(port, '/sim/blotter', { rows: 0 })).status).toBe(400);
    expect((await post(port, '/sim/blotter', { rows: 5001 })).status).toBe(400);
  });
});

describe('/sim/scenario (done-when of T-0.4.7)', () => {
  // Spec §8 read from stats: calm → spike → naive → batched again →
  // (crash on the wire) → calm after recovery → last look armed.
  const CANONICAL = [
    '300/true/40/0',
    '50000/true/40/0',
    '50000/false/40/0',
    '50000/true/40/0',
    '2000/true/40/0',
    '2000/true/80/0.3',
  ];

  /** Sampling may MISS a short-lived posture, never invent or reorder one. */
  function isSubsequence(observed: string[], canonical: string[]): boolean {
    let at = 0;
    for (const seen of observed) {
      while (at < canonical.length && canonical[at] !== seen) at += 1;
      if (at === canonical.length) return false;
      at += 1;
    }
    return true;
  }

  it('demo-5min plays the full §8 sequence — asserted from /sim/stats — identically twice from the same seed', { timeout: 40_000 }, async () => {
    const port = await startServer({ updatesPerSec: 1000 });

    const posture = (s: SimStats): string =>
      `${s.updatesPerSec}/${s.batch}/${s.executions.lastLook.holdMs}/${s.executions.lastLook.rejectRate}`;

    async function play(): Promise<{ observed: string[]; applied: number; closeCode: number }> {
      expect((await post(port, '/sim/seed', { seed: 11 })).status).toBe(200);
      const { ws } = await openFeed(port);
      const closeCode = new Promise<number>((resolve) => ws.on('close', resolve));

      const res = await post(port, '/sim/scenario', { name: 'demo-5min', speed: 50 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; steps: number; durationMs: number };
      expect(body).toEqual({ ok: true, steps: 11, durationMs: 4800 });

      // Sample the stats-visible posture while the play runs; the applied
      // counter — not the sampling — decides when the play is over, so a
      // slow poll can shorten the observation but never hang the test.
      const observed: string[] = [];
      let applied = 0;
      const deadline = Date.now() + body.durationMs + 8000;
      for (;;) {
        const stats = await getStats(port);
        const seen = posture(stats);
        if (observed[observed.length - 1] !== seen) observed.push(seen);
        applied = stats.scenario?.applied ?? 0;
        if (applied === body.steps && seen === CANONICAL[CANONICAL.length - 1]) break;
        if (Date.now() > deadline) throw new Error(`play stalled: applied ${applied}, saw ${observed.join(' → ')}`);
        await settle(15);
      }
      // Drop whatever pre-scenario posture the first samples caught.
      const start = observed.indexOf(CANONICAL[0]!);
      expect(start).toBeGreaterThanOrEqual(0);
      return { observed: observed.slice(start), applied, closeCode: await closeCode };
    }

    const first = await play();
    const second = await play();

    for (const run of [first, second]) {
      // Every step fired, exactly once, in data order — the server counted.
      expect(run.applied).toBe(11);
      // The sampled view is a faithful subsequence of the canonical story…
      expect(isSubsequence(run.observed, CANONICAL)).toBe(true);
      // …and the wide-window anchors are guaranteed catches: the spike holds
      // for 1.2 s and the post-recovery calm for 2 s at this speed.
      expect(run.observed[0]).toBe(CANONICAL[0]);
      expect(run.observed).toContain('50000/true/40/0');
      expect(run.observed).toContain('2000/true/40/0');
      expect(run.observed[run.observed.length - 1]).toBe(CANONICAL[CANONICAL.length - 1]);
      // The scripted crash reached the wire.
      expect(run.closeCode).toBe(4000);
    }
    expect(second.applied).toBe(first.applied);
    expect(second.observed[second.observed.length - 1]).toBe(first.observed[first.observed.length - 1]);
  });

  it('a new scenario cancels the previous one’s pending steps', { timeout: 15_000 }, async () => {
    const port = await startServer();
    // Slow play: its spike would land at 30 s ÷ 20 = 1.5 s…
    expect((await post(port, '/sim/scenario', { name: 'demo-5min', speed: 20 })).status).toBe(200);
    // …but the replacement takes the stage before that.
    expect((await post(port, '/sim/scenario', { name: 'demo-5min', speed: 600 })).status).toBe(200);

    await settle(900); // 300 s ÷ 600 = 500 ms — the fast play has finished
    const after = await getStats(port);
    expect(after.updatesPerSec).toBe(2000);
    expect(after.executions.lastLook).toEqual({ holdMs: 80, rejectRate: 0.3 });

    await settle(900); // past the slow play's spike time: nothing fires
    expect((await getStats(port)).updatesPerSec).toBe(2000);
  });

  it('unknown names and out-of-range speeds die at the border', async () => {
    const port = await startServer();
    expect((await post(port, '/sim/scenario', { name: 'nope' })).status).toBe(400);
    expect((await post(port, '/sim/scenario', { name: 'demo-5min', speed: 0 })).status).toBe(400);
    expect((await post(port, '/sim/scenario', { name: 'demo-5min', speed: 601 })).status).toBe(400);
    expect((await post(port, '/sim/scenario', { name: 'demo-5min', extra: 1 })).status).toBe(400);
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
