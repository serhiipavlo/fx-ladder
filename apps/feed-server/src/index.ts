import process from 'node:process';

import { FX_SUBPROTOCOL } from '@fx/protocol';

import { configFromEnv } from './config';
import { createFeedServer } from './server';

const config = configFromEnv(process.env);
const server = createFeedServer(config);
const port = await server.listen();
console.log(`[feed-server] listening on :${port} — GET /healthz, WS /feed (${FX_SUBPROTOCOL})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
