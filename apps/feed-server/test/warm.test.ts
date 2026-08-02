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
): () => void {
  return client.subscribe<{ executionReports: ExecutionReport }>(
    {
      query: `subscription Reports($clOrdId: ID) {
        executionReports(clOrdId: $clOrdId) {
          clOrdId pair side orderQtyK execType ordStatus lastPx lastQty cumQty leavesQty rejectReason transactTime
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
