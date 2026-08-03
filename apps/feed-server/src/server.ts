import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  applyReport,
  INSTRUMENTS,
  pairIdOf,
  SCENARIOS,
  type ExecutionReport,
  type OrderProgress,
  type RejectReason,
  type ScenarioName,
  type ScenarioStep,
  type SimOrderBody,
} from '@fx/domain';
import {
  assembleFrame,
  encodeFrame,
  encodeFrameBinary,
  FX_SUBPROTOCOL,
  FX_SUBPROTOCOL_V2,
  heartbeatFrame,
  type Frame,
} from '@fx/protocol';
import {
  createExecutionEngine,
  createLedger,
  createMarket,
  xoshiro128,
  type ExecutionEngine,
  type Ledger,
  type Market,
} from '@fx/sim-core';
import { WebSocket, WebSocketServer } from 'ws';

import { handleInstruments } from './cold';
import type { FeedServerConfig } from './config';
import { FieldError, handleSimRequest, percentile, type SimStats } from './control';
import { createWarmPlane } from './warm';

export interface FeedServer {
  /** Binds and resolves with the actual port (pass 0 in config for an ephemeral one). */
  listen(): Promise<number>;
  /** Graceful shutdown: closes every client with 1000, then the listener. */
  close(): Promise<void>;
}

interface ClientState {
  nextSeq: number;
  lastSentTs: number;
  connectedAt: number;
  /** The wire this connection negotiated: fx.v2 sends binary frames (ADR-12). */
  binary: boolean;
}

/**
 * The server's own fold of one order — state recovered from the same events
 * the wire carries (§5.6), served as the reconnect snapshot (T-0.4.8).
 * eventSeq counts the folds: the §6.2 density idea on the warm plane.
 */
interface OrderStateRow {
  progress: OrderProgress;
  lastPx: number | null;
  rejectReason: RejectReason | null;
  eventSeq: number;
  updatedAt: number;
}

/** How often silence is checked for; the heartbeat interval itself is config. */
const HEARTBEAT_SWEEP_MS = 250;

/**
 * Frame-per-update mode sends at most this many frames per wire per tick —
 * ~2000 frames/s at the 8 ms tick, dozens of times past any screen's budget,
 * so the §6.4 client-side collapse demos exactly as before. Uncapped, one
 * wire at 50 k updates/s is 50 k stringify+send a second: the free
 * instance's 0.1 CPU starves, /healthz times out, and the platform kills
 * the instance — the v0.4.0 lesson, learned in production.
 */
const UNBATCHED_MAX_FRAMES_PER_TICK = 16;

/** Ring size for tick-duration samples feeding the /sim/stats percentiles. */
const TICK_SAMPLES = 1024;

/**
 * The engine draws from its own PRNG grown from a derived seed: order flow
 * must not perturb the market's random stream, or /sim/seed bit-identity
 * would depend on order timing.
 */
const ENGINE_SEED_SALT = 0x9e37_79b9;

const engineSeed = (seed: number): number => (seed ^ ENGINE_SEED_SALT) >>> 0;

/**
 * The blotter burst draws pair/side/qty from a third stream for the same
 * reason the engine has a second one: burst composition must perturb neither
 * the market's records nor the engine's own script draws.
 */
const BLOTTER_SEED_SALT = 0x85eb_ca6b;

const blotterSeed = (seed: number): number => (seed ^ BLOTTER_SEED_SALT) >>> 0;

/**
 * Ceiling on live (non-terminal) orders across bursts — the §8 guardrail
 * style: one crude limit, the reason stated, recovery by waiting or reseeding.
 */
const MAX_LIVE_ORDERS = 10_000;

export function createFeedServer(config: FeedServerConfig): FeedServer {
  const allowedOrigins = new Set(config.allowedOrigins);
  const t0 = performance.now();
  /** Monotonic ms since server start — the wire's serverTs and the model's now. */
  const serverTs = (): number => Math.round(performance.now() - t0);

  let updatesPerSec = config.updatesPerSec;
  let market: Market = createMarket(config.seed, updatesPerSec);
  let engine: ExecutionEngine = createExecutionEngine(xoshiro128(engineSeed(config.seed)), (pairId) =>
    market.topOfBook(pairId),
  );
  let orderCounter = 0;
  let ledger: Ledger = createLedger();
  let blotterPrng = xoshiro128(blotterSeed(config.seed));
  const orderStates = new Map<string, OrderStateRow>();

  /**
   * The one door every report leaves through: fold into the server's own
   * order state, stamp the dense per-order eventSeq, then fan out. The stamp
   * happens at publish — a delivery-time lookup could number a queued report
   * with a successor's count.
   */
  function publishReport(report: ExecutionReport): void {
    const meta = ledger.orderMeta(report.clOrdId);
    // A reseed between a submit and its deferred publish is a new trading
    // day (ADR-10): the old day's report has no home and no audience.
    if (meta === undefined) return;
    const existing = orderStates.get(report.clOrdId);
    const progress = applyReport(existing?.progress ?? null, report, meta.qtyK);
    const state: OrderStateRow = {
      progress,
      lastPx: report.execType === 'TRADE' ? report.lastPx : (existing?.lastPx ?? null),
      rejectReason: report.rejectReason,
      eventSeq: (existing?.eventSeq ?? 0) + 1,
      updatedAt: report.transactTime,
    };
    orderStates.set(report.clOrdId, state);
    warm.bus.publish({ ...report, eventSeq: state.eventSeq });
  }
  const lastLook = { holdMs: 40, rejectRate: 0 };
  // Sequencing is per connection: density of seq is a per-wire contract
  // (architecture §6.2), and a snapshot sent to a newcomer must not tear a
  // hole into anyone else's stream.
  const clients = new Map<WebSocket, ClientState>();
  const pendingDisconnects = new Set<NodeJS.Timeout>();
  const scenarioTimers = new Set<NodeJS.Timeout>();
  /** Telemetry of the last play: /sim/stats narrates how far it got. */
  let scenarioPlay: { name: ScenarioName; applied: number; steps: number } | null = null;
  let closed = false;

  // Telemetry for /sim/stats — the numbers the perf gate reads (plan §3).
  let generated = 0;
  let sent = 0;
  let framesSent = 0;
  // The server half of the §6.4 contrast: batched tick frames (default) vs
  // one frame per update — the wire shape a naive server would produce.
  let batchMode = true;
  const tickDurations: number[] = [];
  let tickCursor = 0;

  function recordTickDuration(ms: number): void {
    if (tickDurations.length < TICK_SAMPLES) {
      tickDurations.push(ms);
    } else {
      tickDurations[tickCursor] = ms;
      tickCursor = (tickCursor + 1) % TICK_SAMPLES;
    }
  }

  const httpServer = createServer(handleRequest);
  const wss = new WebSocketServer({
    noServer: true,
    // Version negotiation is the subprotocol mechanism doing its job: the
    // newest wire we both speak wins, and a v1-only client stays served.
    handleProtocols: (protocols) =>
      protocols.has(FX_SUBPROTOCOL_V2) ? FX_SUBPROTOCOL_V2 : protocols.has(FX_SUBPROTOCOL) ? FX_SUBPROTOCOL : false,
  });

  /** One frame, the connection's own wire: JSON for fx.v1, bytes for fx.v2. */
  const payloadFor = (state: ClientState, frame: Frame): string | ArrayBuffer =>
    state.binary ? encodeFrameBinary(frame) : encodeFrame(frame);

  wss.on('connection', (ws: WebSocket) => {
    // Snapshot on connect: full book, seq basis 0 — reconnect-and-resnapshot
    // reuses exactly this path (ADR-08).
    const ts = serverTs();
    const { frame, nextSeq } = assembleFrame('SNAPSHOT', market.snapshot(), 0, ts);
    const state: ClientState = { nextSeq, lastSentTs: ts, connectedAt: ts, binary: ws.protocol === FX_SUBPROTOCOL_V2 };
    ws.send(payloadFor(state, frame));
    clients.set(ws, state);

    ws.on('message', () => {
      // The v0.1 data plane is strictly server → client; any inbound frame is
      // a protocol error. The full close-code table lands in v0.2 (§7.1).
      ws.close(4002, 'protocol error: unexpected client message');
    });
    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  const tick = setInterval(() => {
    const started = performance.now();
    const ts = serverTs();
    // Scheduled execution events materialise on the same clock: the ledger
    // books them first (server truth), then every report rides the warm plane
    // to every subscriber, exactly once (§7.3).
    for (const report of engine.advance(ts)) {
      ledger.record(report);
      publishReport(report);
    }
    const updates = market.advance(ts);
    if (updates.length > 0) {
      generated += updates.length;
      for (const [ws, state] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > config.slowClientBufferBytes) {
          // Slow consumer: the deliberately crude guard (§7.1) — one threshold,
          // one close, no degradation modes. Recovery is the ordinary
          // reconnect-and-resnapshot; the tick waits for no one.
          ws.close(4001, 'slow consumer: send queue over limit');
          continue;
        }
        if (batchMode) {
          // One send per client per tick (§7.1); seq assigned last, per wire (§6.2).
          const { frame, nextSeq } = assembleFrame('DELTA', updates, state.nextSeq, ts);
          ws.send(payloadFor(state, frame));
          state.nextSeq = nextSeq;
          framesSent += 1;
          sent += updates.length;
        } else {
          // batch:false — a frame per update, the §6.4 pathology on demand,
          // capped per wire (§8 guardrail): the pathology exists to choke a
          // naive CLIENT, and ~2000 frames/s do that dozens of times over —
          // while an uncapped 50k/s of stringify+send starves a 0.1-CPU
          // instance until the platform health check kills it. The newest
          // updates win the slice: freshest book, and skipped upserts are
          // legal on this plane (full upserts — coalescing allowed, §6.1).
          const firehose = updates.slice(-UNBATCHED_MAX_FRAMES_PER_TICK);
          for (const update of firehose) {
            const { frame, nextSeq } = assembleFrame('DELTA', [update], state.nextSeq, ts);
            ws.send(payloadFor(state, frame));
            state.nextSeq = nextSeq;
            framesSent += 1;
          }
          sent += firehose.length;
        }
        state.lastSentTs = ts;
      }
    }
    recordTickDuration(performance.now() - started);
  }, config.tickMs);

  const heartbeat = setInterval(() => {
    const ts = serverTs();
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ts - state.connectedAt >= config.sessionCeilingMs) {
        // A deliberate goodbye, not an error: the client's 1000-policy stops
        // reconnecting and the UI offers to continue instead (architecture §8).
        ws.close(1000, 'session ceiling reached — press Reconnect to continue');
        continue;
      }
      if (ts - state.lastSentTs < config.heartbeatIntervalMs) continue;
      // Silence becomes a signal: channel alive, market quiet — and the last
      // assigned seq proves completeness without new data (§6.3).
      ws.send(payloadFor(state, heartbeatFrame(state.nextSeq - 1, ts)));
      state.lastSentTs = ts;
    }
  }, HEARTBEAT_SWEEP_MS);

  /**
   * The one submit path both doors share (§7.3): freshness is the server's
   * own state at processing time, and immediate rejections defer onto the
   * next macrotask so every outcome reaches subscribers as an event, after
   * any ack. /sim/order additionally returns them in its response.
   */
  function submitOrderShared(input: SimOrderBody & { pairId: number }): {
    clOrdId: string;
    immediate: ExecutionReport[];
  } {
    const clOrdId = input.clOrdId ?? `srv-${(orderCounter += 1)}`;
    ledger.open(clOrdId, input.pairId, input.side, input.qtyK);
    const immediate = engine.submit(
      { clOrdId, pairId: input.pairId, side: input.side, qtyK: input.qtyK, tif: input.tif },
      serverTs(),
      { stale: market.isFrozen(input.pairId) },
    );
    if (immediate.length > 0) {
      for (const report of immediate) ledger.record(report);
      setTimeout(() => {
        for (const report of immediate) publishReport(report);
      }, 0);
    }
    return { clOrdId, immediate };
  }

  const warm = createWarmPlane({
    submitOrder: submitOrderShared,
    serverTs,
    trades: (pairId) => ledger.trades(pairId),
    positions: () => ledger.positions(),
    orderMeta: (clOrdId) => ledger.orderMeta(clOrdId),
    orders: () =>
      [...orderStates.entries()].map(([clOrdId, state]) => {
        const meta = ledger.orderMeta(clOrdId)!;
        return {
          clOrdId,
          pair: INSTRUMENTS[meta.pairId]!.symbol,
          side: meta.side,
          orderQtyK: meta.qtyK,
          ordStatus: state.progress.status,
          cumQty: state.progress.cumQty,
          leavesQty: state.progress.leavesQty,
          lastPx: state.lastPx,
          rejectReason: state.rejectReason,
          eventSeq: state.eventSeq,
          updatedAt: state.updatedAt,
        };
      }),
  });

  // What /sim/* is allowed to do to this server (architecture §8).
  const controlDeps = {
    reseed(seed: number): void {
      market = createMarket(seed, updatesPerSec);
      // Reseed is a new trading day (ADR-10): open orders and the blotter do
      // not survive it.
      engine = createExecutionEngine(xoshiro128(engineSeed(seed)), (pairId) => market.topOfBook(pairId), {
        holdMs: lastLook.holdMs,
        rejectRate: lastLook.rejectRate,
      });
      ledger = createLedger();
      blotterPrng = xoshiro128(blotterSeed(seed));
      orderStates.clear();
      // Connected clients' books are stale wholesale: push each a fresh
      // SNAPSHOT that keeps its wire dense — same mechanics as resync (ADR-08).
      const ts = serverTs();
      const snapshot = market.snapshot();
      for (const [ws, state] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const { frame, nextSeq } = assembleFrame('SNAPSHOT', snapshot, state.nextSeq, ts);
        ws.send(payloadFor(state, frame));
        state.nextSeq = nextSeq;
        state.lastSentTs = ts;
        sent += frame.count;
      }
    },
    setRate(next: number): void {
      updatesPerSec = next;
      market.setRate(next);
    },
    skipSeqs(count: number): void {
      // A pure numbering jump: the next assembly on every wire starts `count`
      // seqs later — exactly one provable hole per client (NFR-08).
      for (const state of clients.values()) state.nextSeq += count;
    },
    news(pairId: number, pips: number, spreadX: number): void {
      // The shock and the owed both-side refresh ride the next tick (§5.3).
      market.news(pairId, pips, spreadX);
    },
    setBatch(batch: boolean): void {
      batchMode = batch;
    },
    freeze(pairId: number, ms: number): void {
      market.freeze(pairId, ms);
    },
    setLastLook(holdMs: number, rejectRate: number): void {
      lastLook.holdMs = holdMs;
      lastLook.rejectRate = rejectRate;
      engine.setLastLook(holdMs, rejectRate);
    },
    submitOrder: submitOrderShared,
    blotter(rows: number): { submitted: number } {
      const s = engine.stats();
      const live = s.submitted - s.filled - s.canceled - s.rejected;
      if (live + rows > MAX_LIVE_ORDERS) {
        throw new FieldError('rows', `engine holds ${live} live orders; retry once the burst settles, or reseed`);
      }
      // Through the ordinary door, one order at a time: the ledger registers,
      // the engine scripts, every report rides the subscription — the 5000
      // rows the grid renders exist in the same books as any ticket's order.
      for (let i = 0; i < rows; i += 1) {
        const pairId = blotterPrng.nextUint32() % INSTRUMENTS.length;
        submitOrderShared({
          pair: INSTRUMENTS[pairId]!.symbol,
          pairId,
          side: blotterPrng.nextUint32() % 2 === 0 ? 'buy' : 'sell',
          qtyK: 1 + (blotterPrng.nextUint32() % 2000),
          tif: blotterPrng.nextFloat() < 0.25 ? 'IOC' : 'DAY',
        });
      }
      return { submitted: rows };
    },
    scenario(name: ScenarioName, speed: number): { steps: number; durationMs: number } {
      // One director at a time: a new scenario cancels whatever the previous
      // one still had pending, so a replay never inherits stray commands.
      for (const timer of scenarioTimers) clearTimeout(timer);
      scenarioTimers.clear();
      const steps = SCENARIOS[name];
      const play = { name, applied: 0, steps: steps.length };
      scenarioPlay = play;
      let durationMs = 0;
      for (const step of steps) {
        // The timeline is data; speed only compresses it (offset ÷ speed) —
        // ×1 is the live five-minute demo, tests replay it in seconds.
        const delay = Math.round(step.atMs / speed);
        durationMs = Math.max(durationMs, delay);
        const timer = setTimeout(() => {
          scenarioTimers.delete(timer);
          applyScenarioStep(step);
          // Counted on this play's own record: a replaced scenario cannot
          // bump its successor's progress.
          play.applied += 1;
        }, delay);
        scenarioTimers.add(timer);
      }
      return { steps: steps.length, durationMs };
    },
    disconnect(graceful: boolean, afterMs: number): void {
      // Different endings demand different client reactions (§7.1): 1000 is a
      // deliberate goodbye (no reconnect), 4000 is a simulated crash
      // (reconnect with backoff + jitter).
      const timer = setTimeout(() => {
        pendingDisconnects.delete(timer);
        for (const ws of clients.keys()) {
          if (ws.readyState !== WebSocket.OPEN) continue;
          if (graceful) ws.close(1000, 'disconnected by control plane');
          else ws.close(4000, 'simulated crash');
        }
        if (!graceful) {
          // A crash takes the whole process's connections with it — the warm
          // plane drops too, and owes the T-0.4.8 story: resubscribe plus
          // snapshot reconciliation. A graceful goodbye is a hot-plane
          // demonstration and leaves the warm socket alone.
          for (const ws of warm.wss.clients) {
            if (ws.readyState === WebSocket.OPEN) ws.close(4000, 'simulated crash');
          }
        }
      }, afterMs);
      pendingDisconnects.add(timer);
    },
    stats(): SimStats {
      return {
        generated,
        sent,
        framesSent,
        batch: batchMode,
        updatesPerSec,
        clients: clients.size,
        uptimeMs: serverTs(),
        executions: { ...engine.stats(), lastLook: { ...lastLook } },
        scenario: scenarioPlay === null ? null : { ...scenarioPlay },
        tick: {
          p50: percentile(tickDurations, 50),
          p95: percentile(tickDurations, 95),
          p99: percentile(tickDurations, 99),
          max: percentile(tickDurations, 100),
          samples: tickDurations.length,
        },
      };
    },
  };

  /** Scenario steps reuse the exact control-plane actions, one per command. */
  function applyScenarioStep(step: ScenarioStep): void {
    switch (step.action) {
      case 'rate':
        controlDeps.setRate(step.updatesPerSec);
        break;
      case 'mode':
        controlDeps.setBatch(step.batch);
        break;
      case 'news':
        // Timeline pairs are proven resolvable by the domain's scenario test.
        controlDeps.news(pairIdOf(step.pair), step.pips, step.spreadX);
        break;
      case 'freeze':
        controlDeps.freeze(pairIdOf(step.pair), step.ms);
        break;
      case 'lastlook':
        controlDeps.setLastLook(step.holdMs, step.rejectRate);
        break;
      case 'disconnect':
        controlDeps.disconnect(step.graceful, 0);
        break;
    }
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;
    const origin = req.headers.origin;
    // CORS lives on the fetch paths; the WS path is guarded by the Origin
    // check on upgrade instead (architecture §9.2 — two halves of one defence).
    if (origin !== undefined && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      // CORS preflight for cross-origin POSTs from the docs page (and the
      // v0.2 demo panel). The grant itself was set above for allowed origins
      // only; a foreign origin gets a bare 204 the browser will refuse.
      // x-sim-secret is granted unconditionally: an operator's own tooling
      // may carry it, and granting a header name reveals nothing.
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, x-sim-secret',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeMs: serverTs() }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/instruments') {
      handleInstruments(req, res);
      return;
    }

    if (pathname.startsWith('/sim/')) {
      // The optional lock (T-1.0.2): with FX_SIM_SECRET set, the control
      // plane answers only to the matching header; the data planes are not
      // consulted and stay open. Off by default — the public demo WANTS the
      // world steerable from the page.
      if (config.simSecret !== null && !secretMatches(req.headers['x-sim-secret'], config.simSecret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'control plane is locked: missing or wrong x-sim-secret header' }));
        return;
      }
      handleSimRequest(pathname, req, res, controlDeps);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  /** Constant-time comparison — a lock this cheap should still be a real one. */
  function secretMatches(offered: string | string[] | undefined, secret: string): boolean {
    if (typeof offered !== 'string') return false;
    const a = Buffer.from(offered);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function refuseUpgrade(socket: Duplex, status: number, reason: string, body = ''): void {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    socket.destroy();
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;
    if (pathname !== '/feed' && pathname !== '/graphql') {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    // Browsers cannot fake Origin; non-browser clients can, and that is fine —
    // this guard only cuts drive-by embedding from foreign sites (architecture §7.1).
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (pathname === '/graphql') {
      // The warm plane on the same port, routed by path (ADR-05); graphql-ws
      // negotiates its own subprotocol and heartbeats.
      warm.wss.handleUpgrade(req, socket, head, (ws) => {
        warm.wss.emit('connection', ws, req);
      });
      return;
    }
    // Refuse incompatible clients at the door with a server-side 400: ws's own
    // handleProtocols=false would instead complete the 101 without a subprotocol
    // and leave the rejection to the client — a quiet failure, not a loud one.
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!offered.includes(FX_SUBPROTOCOL) && !offered.includes(FX_SUBPROTOCOL_V2)) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    // Resource guard for the unattended public link (architecture §8): the
    // (N+1)-th client is refused at the door with the reason stated.
    if (clients.size >= config.maxClients) {
      refuseUpgrade(socket, 503, 'Service Unavailable', `client limit reached (${config.maxClients})`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, () => {
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(tick);
      clearInterval(heartbeat);
      for (const timer of pendingDisconnects) clearTimeout(timer);
      for (const timer of scenarioTimers) clearTimeout(timer);
      for (const client of wss.clients) client.close(1000, 'server shutting down');
      for (const client of warm.wss.clients) client.close(1000, 'server shutting down');
      return warm.close().then(
        () =>
          new Promise((resolve, reject) => {
            wss.close(() => {
              httpServer.close((err) => (err ? reject(err) : resolve()));
              httpServer.closeIdleConnections();
            });
          }),
      );
    },
  };
}
