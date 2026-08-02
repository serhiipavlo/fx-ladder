import { applyReport, isTerminalStatus, type ExecutionReport, type OrderProgress } from '@fx/domain';
import { decodeFrame, FX_SUBPROTOCOL, type Frame } from '@fx/protocol';
import { createClient, type Client } from 'graphql-ws';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { FeedServerConfig } from '../src/config';
import { createFeedServer, type FeedServer } from '../src/server';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function testConfig(overrides: Partial<FeedServerConfig> = {}): FeedServerConfig {
  return {
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    heartbeatIntervalMs: 1000,
    tickMs: 10,
    seed: 42,
    updatesPerSec: 1000,
    slowClientBufferBytes: 1_000_000,
    maxClients: 20,
    sessionCeilingMs: 30 * 60_000,
    ...overrides,
  };
}

const servers: FeedServer[] = [];
const clients: Client[] = [];
const sockets: WebSocket[] = [];

async function startServer(overrides: Partial<FeedServerConfig> = {}): Promise<number> {
  const server = createFeedServer(testConfig(overrides));
  servers.push(server);
  return server.listen();
}

function gql(port: number): Client {
  const client = createClient({
    url: `ws://127.0.0.1:${port}/graphql`,
    webSocketImpl: WebSocket,
    retryAttempts: 0,
    lazy: false,
    // Non-lazy clients report terminal closes to console.error by default;
    // tests kill sockets on purpose and assert the outcomes themselves.
    onNonLazyError: () => undefined,
  });
  clients.push(client);
  return client;
}

async function runOperation<T>(client: Client, query: string, variables?: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    client.subscribe<T>(
      { query, variables },
      {
        next: (value) => {
          // Resolver errors ride the next payload per the graphql-ws protocol;
          // the error callback carries only transport/validation failures.
          if (value.errors !== undefined && value.errors.length > 0) {
            reject(new Error(value.errors.map((e) => e.message).join('; ')));
            return;
          }
          result = value.data as T;
        },
        error: (err) => reject(err instanceof Error ? err : new Error(JSON.stringify(err))),
        complete: () => resolve(result as T),
      },
    );
  });
}

function collectReports(
  client: Client,
  sink: ExecutionReport[],
  clOrdId?: string,
  onEvent?: () => void,
  onError?: (err: unknown) => void,
): () => void {
  return client.subscribe<{ executionReports: ExecutionReport }>(
    {
      query: `subscription Reports($clOrdId: ID) {
        executionReports(clOrdId: $clOrdId) {
          clOrdId pair side orderQtyK eventSeq execType ordStatus lastPx lastQty cumQty leavesQty rejectReason transactTime
        }
      }`,
      variables: { clOrdId: clOrdId ?? null },
    },
    {
      next: (value) => {
        sink.push(value.data!.executionReports);
        onEvent?.();
      },
      error: (err) => {
        if (onError !== undefined) {
          onError(err);
          return;
        }
        throw err instanceof Error ? err : new Error(JSON.stringify(err));
      },
      complete: () => undefined,
    },
  );
}

const SUBMIT = `mutation Submit($input: OrderInput!) {
  submitOrder(input: $input) { clOrdId receivedAt }
}`;

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await settle(50);
  }
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

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(clients.splice(0).map((client) => Promise.resolve(client.dispose()).catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('warm plane transport (done-when of T-0.4.1)', () => {
  it('graphql-ws completes on the same port that serves /feed, and /feed is unaffected', async () => {
    const port = await startServer({ updatesPerSec: 2000 });
    const { frames } = await openFeed(port);
    await settle(150);
    const framesBefore = frames.length;

    const client = gql(port);
    const trades = await runOperation<{ trades: unknown[] }>(client, `query { trades { clOrdId } }`);
    expect(trades.trades).toEqual([]);
    const positions = await runOperation<{ positions: unknown[] }>(client, `query { positions { pair } }`);
    expect(positions.positions).toEqual([]);

    await settle(300);
    // The hot plane never noticed: frames kept flowing and stayed dense.
    expect(frames.length).toBeGreaterThan(framesBefore);
    const data = frames.filter((f) => f.frameType !== 'HEARTBEAT');
    for (let i = 1; i < data.length; i += 1) {
      expect(data[i]!.firstSeq).toBe(data[i - 1]!.firstSeq + data[i - 1]!.count);
    }
  });
});

describe('submitOrder (done-when of T-0.4.2)', () => {
  it('the ack returns before the first ExecutionReport', async () => {
    const port = await startServer();
    const client = gql(port);
    const arrivals: string[] = [];
    const sink: ExecutionReport[] = [];
    collectReports(client, sink, undefined, () => arrivals.push('report'));
    await settle(100); // subscription established

    const ack = await runOperation<{ submitOrder: { clOrdId: string } }>(client, SUBMIT, {
      input: { pair: 'EURUSD', side: 'buy', qtyK: 200, tif: 'DAY' },
    });
    arrivals.push('ack');
    expect(ack.submitOrder.clOrdId).toBeTruthy();

    await until(() => sink.some((r) => r.clOrdId === ack.submitOrder.clOrdId));
    expect(arrivals[0]).toBe('ack');

    // Enrichment (§7.3): the wire report knows its order without a registry.
    const enriched = sink.find((r) => r.clOrdId === ack.submitOrder.clOrdId)! as ExecutionReport & {
      pair: string;
      side: string;
      orderQtyK: number;
    };
    expect(enriched.pair).toBe('EURUSD');
    expect(enriched.side).toBe('buy');
    expect(enriched.orderQtyK).toBe(200);
  });

  it('a freshness-rejected order still acks, then reports the rejection as an event', async () => {
    const port = await startServer();
    // Freeze first: the client believes the price fresh, the server knows better.
    const frozen = await fetch(`http://127.0.0.1:${port}/sim/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pair: 'USDJPY', ms: 5000 }),
    });
    expect(frozen.status).toBe(200);

    const client = gql(port);
    const sink: ExecutionReport[] = [];
    collectReports(client, sink);
    await settle(100);

    const ack = await runOperation<{ submitOrder: { clOrdId: string } }>(client, SUBMIT, {
      input: { pair: 'USDJPY', side: 'buy', qtyK: 100, tif: 'DAY' },
    });
    expect(ack.submitOrder.clOrdId).toBeTruthy(); // the ack is unconditional

    await until(() => sink.length > 0);
    expect(sink[0]!.clOrdId).toBe(ack.submitOrder.clOrdId);
    expect(sink[0]!.execType).toBe('REJECTED');
    expect(sink[0]!.rejectReason).toBe('STALE_PRICE');
  });

  it('an unknown pair fails the mutation itself — schema-level, not a lifecycle', async () => {
    const port = await startServer();
    const client = gql(port);
    await expect(
      runOperation(client, SUBMIT, { input: { pair: 'ZZZZZZ', side: 'buy', qtyK: 10, tif: 'DAY' } }),
    ).rejects.toThrow(/unknown pair/);
  });
});

describe('executionReports (done-when of T-0.4.3)', () => {
  it('100 concurrent orders: no event duplicated, dropped or reordered — per clOrdId', { timeout: 20_000 }, async () => {
    const port = await startServer();
    // Mixed outcomes: some bounce at last look.
    await fetch(`http://127.0.0.1:${port}/sim/lastlook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdMs: 30, rejectRate: 0.2 }),
    });

    const client = gql(port);
    const sink: ExecutionReport[] = [];
    collectReports(client, sink);
    await settle(100);

    const acks = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        runOperation<{ submitOrder: { clOrdId: string } }>(client, SUBMIT, {
          input: {
            clOrdId: `W-${i}`,
            pair: ['EURUSD', 'GBPUSD', 'USDCHF', 'AUDUSD'][i % 4],
            side: i % 2 === 0 ? 'buy' : 'sell',
            qtyK: 100 + (i % 7) * 200,
            tif: i % 3 === 0 ? 'IOC' : 'DAY',
          },
        }),
      ),
    );
    expect(new Set(acks.map((a) => a.submitOrder.clOrdId)).size).toBe(100);

    const terminals = (): number => {
      const byOrder = new Map<string, ExecutionReport[]>();
      for (const r of sink) {
        const list = byOrder.get(r.clOrdId) ?? [];
        list.push(r);
        byOrder.set(r.clOrdId, list);
      }
      let done = 0;
      for (const [, reports] of byOrder) {
        const last = reports[reports.length - 1]!;
        if (isTerminalStatus(last.ordStatus)) done += 1;
      }
      return done;
    };
    await until(() => terminals() === 100, 15_000);

    // The §5.6 machine is the referee: a duplicate breaks the cum arithmetic,
    // a reorder breaks a transition, a drop breaks the identity — any of them
    // throws in the fold.
    const byOrder = new Map<string, ExecutionReport[]>();
    for (const r of sink) {
      const list = byOrder.get(r.clOrdId) ?? [];
      list.push(r);
      byOrder.set(r.clOrdId, list);
    }
    expect(byOrder.size).toBe(100);
    for (const [clOrdId, reports] of byOrder) {
      expect(clOrdId.startsWith('W-')).toBe(true);
      const orderQty = 100 + (Number(clOrdId.slice(2)) % 7) * 200;
      let progress: OrderProgress | null = null;
      let terminalCount = 0;
      for (const r of reports) {
        progress = applyReport(progress, r, orderQty);
        if (isTerminalStatus(progress.status)) terminalCount += 1;
      }
      expect(terminalCount).toBe(1);
    }
  });

  it('buy-then-sell: trades land in the blotter, position flattens, realised P&L is the fill arithmetic', { timeout: 15_000 }, async () => {
    const port = await startServer();
    const client = gql(port);
    const sink: ExecutionReport[] = [];
    collectReports(client, sink);
    await settle(100);

    await runOperation(client, SUBMIT, { input: { clOrdId: 'BUY', pair: 'EURUSD', side: 'buy', qtyK: 300, tif: 'DAY' } });
    await until(() => sink.some((r) => r.clOrdId === 'BUY' && isTerminalStatus(r.ordStatus)));
    await runOperation(client, SUBMIT, { input: { clOrdId: 'SELL', pair: 'EURUSD', side: 'sell', qtyK: 300, tif: 'DAY' } });
    await until(() => sink.some((r) => r.clOrdId === 'SELL' && isTerminalStatus(r.ordStatus)));

    const fills = (id: string) => sink.filter((r) => r.clOrdId === id && r.execType === 'TRADE');
    const buyFills = fills('BUY');
    const sellFills = fills('SELL');
    const avgBuy = buyFills.reduce((s, r) => s + r.lastPx! * r.lastQty!, 0) / 300;
    const expectedRealised = sellFills.reduce((s, r) => s + (r.lastPx! - avgBuy) * r.lastQty!, 0);

    const { trades } = await runOperation<{ trades: Array<{ clOrdId: string; pair: string; priceP: number }> }>(
      client,
      `query { trades(pair: "EURUSD") { clOrdId pair priceP } }`,
    );
    expect(trades).toHaveLength(buyFills.length + sellFills.length);
    expect(trades.every((t) => t.pair === 'EURUSD')).toBe(true);

    const { positions } = await runOperation<{
      positions: Array<{ pair: string; netQtyK: number; avgPx: number; realisedPnl: number }>;
    }>(client, `query { positions { pair netQtyK avgPx realisedPnl } }`);
    const eurusd = positions.find((p) => p.pair === 'EURUSD')!;
    expect(eurusd.netQtyK).toBe(0);
    expect(eurusd.avgPx).toBe(0);
    expect(eurusd.realisedPnl).toBeCloseTo(expectedRealised, 6);

    await expect(runOperation(client, `query { trades(pair: "ZZZZZZ") { clOrdId } }`)).rejects.toThrow(/unknown pair/);
  });

  it('a /sim/blotter burst rides the subscription: enriched, complete, grammar-clean', { timeout: 15_000 }, async () => {
    const port = await startServer();
    const client = gql(port);
    const sink: ExecutionReport[] = [];
    collectReports(client, sink);
    await settle(100);

    const res = await fetch(`http://127.0.0.1:${port}/sim/blotter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: 25 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submitted: 25 });

    const byOrder = (): Map<string, ExecutionReport[]> => {
      const grouped = new Map<string, ExecutionReport[]>();
      for (const r of sink) {
        const list = grouped.get(r.clOrdId) ?? [];
        list.push(r);
        grouped.set(r.clOrdId, list);
      }
      return grouped;
    };
    await until(() => {
      const grouped = byOrder();
      if (grouped.size < 25) return false;
      return [...grouped.values()].every((reports) => isTerminalStatus(reports[reports.length - 1]!.ordStatus));
    });

    // Synthetic orders are indistinguishable on the wire: enriched from the
    // ledger registration and folding clean through the §5.6 machine.
    const grouped = byOrder();
    expect(grouped.size).toBe(25);
    const pairs = new Set<string>();
    for (const [, reports] of grouped) {
      const first = reports[0]! as ExecutionReport & { pair: string; orderQtyK: number };
      pairs.add(first.pair);
      expect(first.orderQtyK).toBeGreaterThanOrEqual(1);
      expect(first.orderQtyK).toBeLessThanOrEqual(2000);
      let progress: OrderProgress | null = null;
      for (const r of reports) progress = applyReport(progress, r, first.orderQtyK);
      expect(isTerminalStatus(progress!.status)).toBe(true);
      // The §6.2 idea on the warm plane: per-order eventSeq is dense from 1 —
      // a hole is provable loss, a repeat a provable duplicate (T-0.4.8).
      const seqs = reports.map((r) => (r as ExecutionReport & { eventSeq: number }).eventSeq);
      expect(seqs).toEqual(Array.from({ length: reports.length }, (_, i) => i + 1));
    }
    expect(pairs.size).toBeGreaterThan(1); // the burst spreads across the catalogue
  });

  it('the orders query serves the server-side fold: the reconnect snapshot (T-0.4.8)', async () => {
    const port = await startServer();
    const client = gql(port);
    const sink: ExecutionReport[] = [];
    collectReports(client, sink);
    await settle(100);

    await runOperation(client, SUBMIT, { input: { clOrdId: 'SNAP', pair: 'EURUSD', side: 'buy', qtyK: 250, tif: 'DAY' } });
    await until(() => sink.some((r) => r.clOrdId === 'SNAP' && isTerminalStatus(r.ordStatus)));

    const { orders } = await runOperation<{
      orders: Array<{
        clOrdId: string;
        pair: string;
        side: string;
        orderQtyK: number;
        ordStatus: string;
        cumQty: number;
        leavesQty: number;
        eventSeq: number;
        updatedAt: number;
      }>;
    }>(
      client,
      `query { orders { clOrdId pair side orderQtyK ordStatus cumQty leavesQty lastPx rejectReason eventSeq updatedAt } }`,
    );
    expect(orders).toHaveLength(1);
    const snap = orders[0]!;
    const seen = sink.filter((r) => r.clOrdId === 'SNAP');
    // The snapshot IS the fold of the events the wire carried: same status,
    // same quantities, and eventSeq equals the number of reports delivered.
    expect(snap).toMatchObject({
      clOrdId: 'SNAP',
      pair: 'EURUSD',
      side: 'buy',
      orderQtyK: 250,
      ordStatus: 'FILLED',
      cumQty: 250,
      leavesQty: 0,
      eventSeq: seen.length,
      updatedAt: seen[seen.length - 1]!.transactTime,
    });
  });

  it('a forced crash drops the warm socket too; events fired into the outage are recovered from the snapshot', { timeout: 15_000 }, async () => {
    const port = await startServer();
    // Slow the lifecycle so the whole order plays out while nobody listens.
    await fetch(`http://127.0.0.1:${port}/sim/lastlook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdMs: 300, rejectRate: 0 }),
    });

    const before = gql(port);
    const closed = new Promise<number>((resolve) => {
      before.on('closed', (event) => resolve((event as { code: number }).code));
    });
    const seenBefore: ExecutionReport[] = [];
    // This subscription is MEANT to die with the socket — its error is the point.
    collectReports(before, seenBefore, 'GONE', undefined, () => undefined);
    await settle(100);

    const submitted = await fetch(`http://127.0.0.1:${port}/sim/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clOrdId: 'GONE', pair: 'EURUSD', side: 'buy', qtyK: 400 }),
    });
    expect(submitted.status).toBe(200);

    // The crash lands before the last-look window opens: the entire
    // lifecycle fires into the outage.
    const dropped = await fetch(`http://127.0.0.1:${port}/sim/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graceful: false }),
    });
    expect(dropped.status).toBe(200);
    expect(await closed).toBe(4000); // the warm plane crashed with the rest
    expect(seenBefore).toHaveLength(0);

    await settle(1200); // NEW + fills play out with no subscriber anywhere

    // The reconnected client takes state wholesale (ADR-08): the snapshot
    // carries the whole outage — nothing lost, and with no events left to
    // deliver, nothing to duplicate.
    const after = gql(port);
    const { orders } = await runOperation<{
      orders: Array<{ clOrdId: string; ordStatus: string; cumQty: number; leavesQty: number; eventSeq: number }>;
    }>(after, `query { orders { clOrdId ordStatus cumQty leavesQty eventSeq } }`);
    const gone = orders.find((o) => o.clOrdId === 'GONE')!;
    expect(gone.ordStatus).toBe('FILLED');
    expect(gone.cumQty).toBe(400);
    expect(gone.leavesQty).toBe(0);
    expect(gone.eventSeq).toBeGreaterThanOrEqual(2); // NEW + at least one fill, all absorbed

    // The plane lives on: a fresh order on the new socket streams densely from 1.
    const seenAfter: ExecutionReport[] = [];
    collectReports(after, seenAfter, 'BACK');
    await settle(100);
    await runOperation(after, SUBMIT, { input: { clOrdId: 'BACK', pair: 'GBPUSD', side: 'sell', qtyK: 100, tif: 'DAY' } });
    await until(() => seenAfter.some((r) => isTerminalStatus(r.ordStatus)));
    const seqs = seenAfter.map((r) => (r as ExecutionReport & { eventSeq: number }).eventSeq);
    expect(seqs).toEqual(Array.from({ length: seenAfter.length }, (_, i) => i + 1));
  });

  it('a graceful goodbye is a hot-plane story: the warm socket stays open', async () => {
    const port = await startServer();
    const client = gql(port);
    let closedCode: number | null = null;
    client.on('closed', (event) => {
      closedCode = (event as { code: number }).code;
    });
    const sink: ExecutionReport[] = [];
    collectReports(client, sink);
    await settle(100);

    const res = await fetch(`http://127.0.0.1:${port}/sim/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graceful: true }),
    });
    expect(res.status).toBe(200);
    await settle(300);
    expect(closedCode).toBeNull();

    // Still connected and still delivering.
    await runOperation(client, SUBMIT, { input: { clOrdId: 'ALIVE', pair: 'EURUSD', side: 'buy', qtyK: 50, tif: 'DAY' } });
    await until(() => sink.some((r) => r.clOrdId === 'ALIVE'));
  });

  it('a filtered subscription sees exactly its own order', async () => {
    const port = await startServer();
    const client = gql(port);
    const mine: ExecutionReport[] = [];
    collectReports(client, mine, 'MINE');
    await settle(100);

    await runOperation(client, SUBMIT, { input: { clOrdId: 'MINE', pair: 'EURUSD', side: 'buy', qtyK: 50, tif: 'DAY' } });
    await runOperation(client, SUBMIT, { input: { clOrdId: 'OTHER', pair: 'GBPUSD', side: 'sell', qtyK: 50, tif: 'DAY' } });

    await until(() => mine.some((r) => isTerminalStatus(r.ordStatus)));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.clOrdId === 'MINE')).toBe(true);
  });
});
