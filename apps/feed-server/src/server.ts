import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import type { SimOrderBody } from '@fx/domain';
import { assembleFrame, encodeFrame, FX_SUBPROTOCOL, heartbeatFrame } from '@fx/protocol';
import { createExecutionEngine, createMarket, xoshiro128, type ExecutionEngine, type Market } from '@fx/sim-core';
import { WebSocket, WebSocketServer } from 'ws';

import type { FeedServerConfig } from './config';
import { handleSimRequest, percentile, type SimStats } from './control';

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
}

/** How often silence is checked for; the heartbeat interval itself is config. */
const HEARTBEAT_SWEEP_MS = 250;

/** Ring size for tick-duration samples feeding the /sim/stats percentiles. */
const TICK_SAMPLES = 1024;

/**
 * The engine draws from its own PRNG grown from a derived seed: order flow
 * must not perturb the market's random stream, or /sim/seed bit-identity
 * would depend on order timing.
 */
const ENGINE_SEED_SALT = 0x9e37_79b9;

const engineSeed = (seed: number): number => (seed ^ ENGINE_SEED_SALT) >>> 0;

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
  const lastLook = { holdMs: 40, rejectRate: 0 };
  // Sequencing is per connection: density of seq is a per-wire contract
  // (architecture §6.2), and a snapshot sent to a newcomer must not tear a
  // hole into anyone else's stream.
  const clients = new Map<WebSocket, ClientState>();
  const pendingDisconnects = new Set<NodeJS.Timeout>();
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
    handleProtocols: (protocols) => (protocols.has(FX_SUBPROTOCOL) ? FX_SUBPROTOCOL : false),
  });

  wss.on('connection', (ws: WebSocket) => {
    // Snapshot on connect: full book, seq basis 0 — reconnect-and-resnapshot
    // reuses exactly this path (ADR-08).
    const ts = serverTs();
    const { frame, nextSeq } = assembleFrame('SNAPSHOT', market.snapshot(), 0, ts);
    ws.send(encodeFrame(frame));
    clients.set(ws, { nextSeq, lastSentTs: ts, connectedAt: ts });

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
    // Scheduled execution events materialise on the same clock; their
    // transport is the warm plane (v0.4) — today they feed the stats.
    engine.advance(ts);
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
          ws.send(encodeFrame(frame));
          state.nextSeq = nextSeq;
          framesSent += 1;
        } else {
          // batch:false — a frame per update, the §6.4 pathology on demand.
          for (const update of updates) {
            const { frame, nextSeq } = assembleFrame('DELTA', [update], state.nextSeq, ts);
            ws.send(encodeFrame(frame));
            state.nextSeq = nextSeq;
            framesSent += 1;
          }
        }
        state.lastSentTs = ts;
        sent += updates.length;
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
      ws.send(encodeFrame(heartbeatFrame(state.nextSeq - 1, ts)));
      state.lastSentTs = ts;
    }
  }, HEARTBEAT_SWEEP_MS);

  // What /sim/* is allowed to do to this server (architecture §8).
  const controlDeps = {
    reseed(seed: number): void {
      market = createMarket(seed, updatesPerSec);
      // Reseed is a new trading day (ADR-10): open orders do not survive it.
      engine = createExecutionEngine(xoshiro128(engineSeed(seed)), (pairId) => market.topOfBook(pairId), {
        holdMs: lastLook.holdMs,
        rejectRate: lastLook.rejectRate,
      });
      // Connected clients' books are stale wholesale: push each a fresh
      // SNAPSHOT that keeps its wire dense — same mechanics as resync (ADR-08).
      const ts = serverTs();
      const snapshot = market.snapshot();
      for (const [ws, state] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const { frame, nextSeq } = assembleFrame('SNAPSHOT', snapshot, state.nextSeq, ts);
        ws.send(encodeFrame(frame));
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
    submitOrder(input: SimOrderBody & { pairId: number }) {
      const clOrdId = input.clOrdId ?? `srv-${(orderCounter += 1)}`;
      // The server is the truth about freshness (§7.3): the check runs against
      // the market's own state at processing time, never the client's belief.
      const immediate = engine.submit(
        { clOrdId, pairId: input.pairId, side: input.side, qtyK: input.qtyK, tif: input.tif },
        serverTs(),
        { stale: market.isFrozen(input.pairId) },
      );
      return { clOrdId, immediate };
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
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
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

    if (pathname.startsWith('/sim/')) {
      handleSimRequest(pathname, req, res, controlDeps);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  function refuseUpgrade(socket: Duplex, status: number, reason: string, body = ''): void {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    socket.destroy();
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;
    if (pathname !== '/feed') {
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
    // Refuse incompatible clients at the door with a server-side 400: ws's own
    // handleProtocols=false would instead complete the 101 without a subprotocol
    // and leave the rejection to the client — a quiet failure, not a loud one.
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!offered.includes(FX_SUBPROTOCOL)) {
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
      for (const client of wss.clients) client.close(1000, 'server shutting down');
      return new Promise((resolve, reject) => {
        wss.close(() => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
          httpServer.closeIdleConnections();
        });
      });
    },
  };
}
