import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { encodeFrame, FX_SUBPROTOCOL, heartbeatFrame } from '@fx/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import type { FeedServerConfig } from './config';

export interface FeedServer {
  /** Binds and resolves with the actual port (pass 0 in config for an ephemeral one). */
  listen(): Promise<number>;
  /** Graceful shutdown: closes every client with 1000, then the listener. */
  close(): Promise<void>;
}

export function createFeedServer(config: FeedServerConfig): FeedServer {
  const allowedOrigins = new Set(config.allowedOrigins);
  const startedAt = Date.now();
  // No market model yet: the last assigned seq stays 0 until the hot plane
  // lands (T-0.1.5). Heartbeats carry it so the client can prove completeness.
  const lastSeq = 0;

  let closed = false;

  const httpServer = createServer(handleRequest);
  const wss = new WebSocketServer({
    noServer: true,
    // Reject any handshake that does not offer fx.v1 — an incompatible client
    // must fail loudly at the door, not decode garbage (architecture §6.1).
    handleProtocols: (protocols) => (protocols.has(FX_SUBPROTOCOL) ? FX_SUBPROTOCOL : false),
  });

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
      res.end(JSON.stringify({ ok: true, uptimeMs: Date.now() - startedAt }));
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

  const heartbeat = setInterval(() => {
    const frame = encodeFrame(heartbeatFrame(lastSeq, Date.now() - startedAt));
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }, config.heartbeatIntervalMs);

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
