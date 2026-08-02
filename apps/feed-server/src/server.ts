import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { assembleFrame, encodeFrame, FX_SUBPROTOCOL, heartbeatFrame } from '@fx/protocol';
import { createMarket } from '@fx/sim-core';
import { WebSocket, WebSocketServer } from 'ws';

import type { FeedServerConfig } from './config';

export interface FeedServer {
  /** Binds and resolves with the actual port (pass 0 in config for an ephemeral one). */
  listen(): Promise<number>;
  /** Graceful shutdown: closes every client with 1000, then the listener. */
  close(): Promise<void>;
}

interface ClientState {
  nextSeq: number;
  lastSentTs: number;
}

/** How often silence is checked for; the heartbeat interval itself is config. */
const HEARTBEAT_SWEEP_MS = 250;

export function createFeedServer(config: FeedServerConfig): FeedServer {
  const allowedOrigins = new Set(config.allowedOrigins);
  const t0 = performance.now();
  /** Monotonic ms since server start — the wire's serverTs and the model's now. */
  const serverTs = (): number => Math.round(performance.now() - t0);

  const market = createMarket(config.seed, config.updatesPerSec);
  // Sequencing is per connection: density of seq is a per-wire contract
  // (architecture §6.2), and a snapshot sent to a newcomer must not tear a
  // hole into anyone else's stream.
  const clients = new Map<WebSocket, ClientState>();
  let closed = false;

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
    clients.set(ws, { nextSeq, lastSentTs: ts });

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
    const ts = serverTs();
    const updates = market.advance(ts);
    if (updates.length === 0) return;
    // One send per client per tick (§7.1); seq assigned last, per wire (§6.2).
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const { frame, nextSeq } = assembleFrame('DELTA', updates, state.nextSeq, ts);
      ws.send(encodeFrame(frame));
      state.nextSeq = nextSeq;
      state.lastSentTs = ts;
    }
  }, config.tickMs);

  const heartbeat = setInterval(() => {
    const ts = serverTs();
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ts - state.lastSentTs < config.heartbeatIntervalMs) continue;
      // Silence becomes a signal: channel alive, market quiet — and the last
      // assigned seq proves completeness without new data (§6.3).
      ws.send(encodeFrame(heartbeatFrame(state.nextSeq - 1, ts)));
      state.lastSentTs = ts;
    }
  }, HEARTBEAT_SWEEP_MS);

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;
    const origin = req.headers.origin;
    // CORS lives on the fetch paths; the WS path is guarded by the Origin
    // check on upgrade instead (architecture §9.2 — two halves of one defence).
    if (origin !== undefined && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeMs: serverTs() }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
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
