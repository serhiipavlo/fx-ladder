import {
  simBlotterBodySchema,
  simDisconnectBodySchema,
  simFreezeBodySchema,
  simGapBodySchema,
  simLastLookBodySchema,
  simModeBodySchema,
  simNewsBodySchema,
  simOrderBodySchema,
  simRateBodySchema,
  simScenarioBodySchema,
  simSeedBodySchema,
} from '@fx/domain';
import { frameEnvelopeSchema, FX_SUBPROTOCOL, wireRecordSchema } from '@fx/protocol';
import { z } from 'zod';

// Both API documents are built from the same Zod schemas that validate live
// traffic — the docs cannot drift from the code, and the drift test next to
// this file makes that a build guarantee, not a habit. Response shapes that
// have no runtime validator (healthz, stats) are declared here by hand.

const FEED_HOST = 'fx-ladder-feed.onrender.com';
const VERSION = '0.1.0';

type JsonSchema = Record<string, unknown>;

function fromZod(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema) as JsonSchema;
  delete json['$schema'];
  return json;
}

// ---------------------------------------------------------------------------
// OpenAPI 3.1 — control plane + healthz
// ---------------------------------------------------------------------------

const OK_RESPONSE = {
  description: 'Applied.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
};

const VALIDATION_RESPONSE = {
  description: 'Body failed the shared domain schema; nothing reached the simulator.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
};

function controlPost(summary: string, description: string, schemaName: string): JsonSchema {
  return {
    post: {
      summary,
      description,
      tags: ['control plane'],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
      },
      responses: { '200': OK_RESPONSE, '400': VALIDATION_RESPONSE },
    },
  };
}

export function buildOpenApi(): JsonSchema {
  return {
    openapi: '3.1.0',
    info: {
      title: 'FX Ladder — control plane',
      version: VERSION,
      description:
        'The `/sim/*` endpoints change the behaviour of the simulated world (architecture §8): ' +
        'tests and demos command the market instead of waiting for luck. Every body is parsed by ' +
        'the same Zod schemas the server enforces — this document is generated from them ' +
        '(`pnpm docs:api`). The market data itself rides a WebSocket, documented in ' +
        '[the AsyncAPI half](./index.html#feed) of this page.',
    },
    servers: [
      { url: '/', description: 'same origin (local dev via the Vite proxy)' },
      { url: `https://${FEED_HOST}`, description: 'live demo backend (free instance — may cold-start ~1 min)' },
    ],
    paths: {
      '/healthz': {
        get: {
          summary: 'Liveness probe',
          tags: ['ops'],
          responses: {
            '200': {
              description: 'Server is up.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
            },
          },
        },
      },
      '/api/instruments': {
        get: {
          summary: 'Instrument catalogue',
          description:
            'The cold plane (architecture §7.2): the catalogue with `ETag` and `Cache-Control: ' +
            'max-age=3600`. A conditional request with a matching `If-None-Match` returns `304` with ' +
            "an empty body — the client's React Query `staleTime` aligns with this `max-age` so both " +
            'cache layers tell one story.',
          tags: ['cold plane'],
          responses: {
            '200': {
              description: 'The catalogue; `pairId` on the hot plane is the index into this array.',
              headers: {
                ETag: { schema: { type: 'string' } },
                'Cache-Control': { schema: { type: 'string', const: 'public, max-age=3600' } },
              },
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Instrument' } },
                },
              },
            },
            '304': { description: 'Unchanged since the version the client holds; headers only.' },
          },
        },
      },
      '/sim/seed': controlPost(
        'Reseed the market',
        'Replaces the market with a fresh one grown from this seed. Identical (seed, commands) ' +
          'produce bit-identical record streams (architecture §5.1). Connected clients receive a ' +
          'mid-stream SNAPSHOT that keeps their wire dense.',
        'SimSeedBody',
      ),
      '/sim/rate': controlPost(
        'Set the record rate',
        'Records per second across all pairs. Capped at 10 000 for v0.1 — the cap ratchets with ' +
          "v0.2's 50k target.",
        'SimRateBody',
      ),
      '/sim/gap': controlPost(
        'Tear a hole into every stream',
        'Jumps every per-connection seq counter by `skipSeqs`: exactly one provable gap per wire, ' +
          'for exercising the client gap detector (NFR-08).',
        'SimGapBody',
      ),
      '/sim/mode': controlPost(
        'Batching on/off',
        'The server half of the §6.4 contrast: `batch: true` (default) accumulates a tick into one ' +
          'frame; `batch: false` sends one frame per update — the wire shape that kills naive clients.',
        'SimModeBody',
      ),
      '/sim/freeze': controlPost(
        'Freeze one pair',
        'The pair goes silent for `ms` while everything else flows: the client must mark it stale, ' +
          'not disconnected (AC-06). On thaw the pair returns with a full refresh.',
        'SimFreezeBody',
      ),
      '/sim/disconnect': controlPost(
        'Drop every client',
        'Graceful (`close 1000` — the client must not reconnect: the goodbye is deliberate) versus a ' +
          'simulated crash (`close 4000` — the client comes back with backoff + jitter). A crash also ' +
          'drops the `/graphql` warm sockets — the whole process "died" — and owes the client ' +
          'resubscription plus snapshot reconciliation (T-0.4.8); a graceful goodbye is a hot-plane ' +
          'demonstration and leaves them alone. `afterMs` delays the drop (architecture §7.1; AC-04, NFR-07).',
        'SimDisconnectBody',
      ),
      '/sim/news': controlPost(
        'News shock',
        'Jumps the mid by `pips` and widens the spread by `spreadX`, decaying back to baseline over ' +
          '10 s — the jump and the widening arrive together, as the economics say they should ' +
          '(architecture §5.3). Unknown pairs are a field-level 400.',
        'SimNewsBody',
      ),
      '/sim/lastlook': controlPost(
        'Arm last look',
        'The two knobs of §5.5: every order is held `holdMs` before any answer and bounces with ' +
          '`REJECTED / LAST_LOOK` with probability `rejectRate` — the controlled rejections of demo step 6.',
        'SimLastLookBody',
      ),
      '/sim/order': controlPost(
        'Submit a synthetic order',
        'The dev-harness door into the execution engine (T-0.3.6): the order expands into a scripted ' +
          'event sequence counted in `/sim/stats`. Immediate rejections (INVALID_QTY, STALE_PRICE on a ' +
          'frozen pair) come back in the response as `immediate`; the user-facing loop arrives with the ' +
          'warm plane in v0.4.',
        'SimOrderBody',
      ),
      '/sim/blotter': controlPost(
        'Blotter load burst',
        '`rows` synthetic orders (≤ 5000 — the AC-11 number) enter through the same submit path as ' +
          'any ticket: the ledger registers them, the engine scripts their lifecycles, every report ' +
          'rides the GraphQL subscription — load data for the blotter exists for real (architecture ' +
          '§5.4). Composition is drawn from a seeded stream: reseed and the same burst replays. A ' +
          'crude ceiling of 10 000 live orders refuses bursts on top of a full book with a ' +
          'field-level 400.',
        'SimBlotterBody',
      ),
      '/sim/scenario': controlPost(
        'Play a scripted demo',
        'The demo as data (architecture §8): a named timeline of control commands — the whole spec ' +
          '§8 in one call. `demo-5min` runs calm → spike → unbatched-and-back → crash → recovery → ' +
          'freeze → news → last look armed, identically every time. `speed` compresses the timeline ' +
          '(offset ÷ speed): ×1 is the live five-minute demo, E2E suites replay it in seconds. A new ' +
          'scenario cancels whatever the previous one had pending. Responds with `steps` and ' +
          '`durationMs` of the compressed play.',
        'SimScenarioBody',
      ),
      '/sim/stats': {
        get: {
          summary: 'Simulator telemetry',
          description: 'The numbers the perf gate reads: counters, current rate, tick-duration percentiles.',
          tags: ['control plane'],
          responses: {
            '200': {
              description: 'Current stats.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SimStats' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        SimSeedBody: fromZod(simSeedBodySchema),
        SimRateBody: fromZod(simRateBodySchema),
        SimGapBody: fromZod(simGapBodySchema),
        SimNewsBody: fromZod(simNewsBodySchema),
        SimDisconnectBody: fromZod(simDisconnectBodySchema),
        SimModeBody: fromZod(simModeBodySchema),
        SimFreezeBody: fromZod(simFreezeBodySchema),
        SimLastLookBody: fromZod(simLastLookBodySchema),
        SimOrderBody: fromZod(simOrderBodySchema),
        SimBlotterBody: fromZod(simBlotterBodySchema),
        SimScenarioBody: fromZod(simScenarioBodySchema),
        Instrument: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'base', 'quote', 'precision', 'pipDigit', 'lotSizeK', 'minQtyK', 'tier'],
          properties: {
            symbol: { type: 'string', description: 'Concatenated pair name, e.g. EURUSD.' },
            base: { type: 'string' },
            quote: { type: 'string' },
            precision: { type: 'integer', description: 'Decimal places of a quoted price.' },
            pipDigit: { type: 'integer', description: '1-based decimal position of one pip.' },
            lotSizeK: { type: 'integer', description: 'Standard lot in thousands of base.' },
            minQtyK: { type: 'integer' },
            tier: { type: 'string', enum: ['major', 'cross', 'exotic'] },
          },
        },
        Ok: {
          type: 'object',
          description:
            'Endpoint-specific fields may accompany `ok`: `clOrdId`/`immediate` on /sim/order, ' +
            '`submitted` on /sim/blotter, `steps`/`durationMs` on /sim/scenario.',
          required: ['ok'],
          properties: { ok: { type: 'boolean', const: true } },
        },
        ValidationError: {
          type: 'object',
          additionalProperties: false,
          required: ['error', 'issues'],
          properties: {
            error: { type: 'string', const: 'validation failed' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'message'],
                properties: {
                  path: { type: 'string', description: 'Field that failed, dot-joined.' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        Health: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'uptimeMs'],
          properties: {
            ok: { type: 'boolean', const: true },
            uptimeMs: { type: 'integer', minimum: 0 },
          },
        },
        SimStats: {
          type: 'object',
          additionalProperties: false,
          required: ['generated', 'sent', 'framesSent', 'batch', 'updatesPerSec', 'clients', 'uptimeMs', 'tick'],
          properties: {
            generated: { type: 'integer', minimum: 0, description: 'Records produced by the model since start.' },
            sent: { type: 'integer', minimum: 0, description: 'Records sent across all clients.' },
            framesSent: { type: 'integer', minimum: 0, description: 'Frames sent across all clients.' },
            batch: { type: 'boolean', description: 'Current /sim/mode: tick frames vs frame-per-update.' },
            executions: {
              type: 'object',
              additionalProperties: false,
              required: ['submitted', 'trades', 'partials', 'filled', 'canceled', 'rejected', 'lastLook'],
              description: 'Execution-engine counters (T-0.3.6): the numbers a dev-harness burst moves.',
              properties: {
                submitted: { type: 'integer', minimum: 0 },
                trades: { type: 'integer', minimum: 0 },
                partials: { type: 'integer', minimum: 0, description: 'TRADEs that left the order alive.' },
                filled: { type: 'integer', minimum: 0 },
                canceled: { type: 'integer', minimum: 0 },
                rejected: { type: 'integer', minimum: 0 },
                lastLook: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['holdMs', 'rejectRate'],
                  properties: {
                    holdMs: { type: 'integer', minimum: 0 },
                    rejectRate: { type: 'number', minimum: 0, maximum: 1 },
                  },
                },
              },
            },
            updatesPerSec: { type: 'integer', minimum: 1 },
            clients: { type: 'integer', minimum: 0 },
            uptimeMs: { type: 'integer', minimum: 0 },
            scenario: {
              description: 'Telemetry of the last /sim/scenario play; null before the first one.',
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'applied', 'steps'],
                  properties: {
                    name: { type: 'string' },
                    applied: { type: 'integer', minimum: 0, description: 'Steps fired so far.' },
                    steps: { type: 'integer', minimum: 0 },
                  },
                },
              ],
            },
            tick: {
              type: 'object',
              additionalProperties: false,
              required: ['p50', 'p95', 'p99', 'max', 'samples'],
              description: 'Tick-duration percentiles (ms) over the last 1024 ticks.',
              properties: {
                p50: { type: 'number', minimum: 0 },
                p95: { type: 'number', minimum: 0 },
                p99: { type: 'number', minimum: 0 },
                max: { type: 'number', minimum: 0 },
                samples: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// AsyncAPI 3.0 — hot plane (/feed)
// ---------------------------------------------------------------------------

function frameSchema(
  frameType: 'SNAPSHOT' | 'DELTA' | 'HEARTBEAT',
  records: JsonSchema,
  overrides: Record<string, JsonSchema> = {},
): JsonSchema {
  const envelope = fromZod(frameEnvelopeSchema);
  const properties = { ...(envelope['properties'] as Record<string, JsonSchema>) };
  properties['frameType'] = { type: 'string', const: frameType };
  properties['records'] = records;
  for (const [key, value] of Object.entries(overrides)) properties[key] = value;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['frameType', 'count', 'firstSeq', 'serverTs', 'records'],
    properties,
  };
}

export function buildAsyncApi(): JsonSchema {
  const recordArray: JsonSchema = {
    type: 'array',
    items: { $ref: '#/components/schemas/WireRecord' },
  };

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'FX Ladder — hot plane',
      version: VERSION,
      description:
        `Batched market-data feed over WebSocket, subprotocol \`${FX_SUBPROTOCOL}\` — a client not ` +
        'offering it is refused at the handshake with HTTP 400 (architecture §6.1). One frame per ' +
        'server tick; every record is a **full upsert** of one book level (`size: 0` = level gone), ' +
        'so duplicates are safe and coalescing is legal.\n\n' +
        '**Seq contract (§6.2).** Records are numbered densely per connection: `firstSeq, ' +
        'firstSeq+1, …` with no holes across frames. Any hole is transport loss — provable ' +
        'arithmetically. Recovery: reconnect and take the fresh SNAPSHOT (ADR-08); a mid-stream ' +
        'SNAPSHOT (after `/sim/seed`) replaces pair state wholesale and continues the same dense wire.\n\n' +
        '**Heartbeat (§6.3).** After a silent second the server sends a HEARTBEAT carrying the last ' +
        'assigned seq: liveness and completeness proven even when the market is quiet.\n\n' +
        '**Close codes:** `1000` — deliberate close (do not reconnect); `4002` — protocol error, e.g. ' +
        'any client→server message on this strictly server→client channel (do not blind-retry). ' +
        '`4000` (simulated crash) and `4001` (slow consumer) arrive with v0.2.',
    },
    defaultContentType: 'application/json',
    servers: {
      production: {
        host: FEED_HOST,
        protocol: 'wss',
        description: 'Live demo backend (free instance — may cold-start ~1 min).',
      },
      local: { host: 'localhost:8080', protocol: 'ws', description: 'Local dev server.' },
    },
    channels: {
      feed: {
        address: '/feed',
        description: `Hot plane. Handshake must offer the \`${FX_SUBPROTOCOL}\` subprotocol; browsers on foreign origins are refused (403).`,
        bindings: {
          ws: {
            method: 'GET',
            headers: {
              type: 'object',
              properties: { 'Sec-WebSocket-Protocol': { type: 'string', const: FX_SUBPROTOCOL } },
            },
            bindingVersion: '0.1.0',
          },
        },
        messages: {
          snapshot: { $ref: '#/components/messages/Snapshot' },
          delta: { $ref: '#/components/messages/Delta' },
          heartbeat: { $ref: '#/components/messages/Heartbeat' },
        },
      },
    },
    operations: {
      receiveFeed: {
        action: 'receive',
        channel: { $ref: '#/channels/feed' },
        summary: 'SNAPSHOT on connect, then DELTA per tick, HEARTBEAT through silence.',
        messages: [
          { $ref: '#/channels/feed/messages/snapshot' },
          { $ref: '#/channels/feed/messages/delta' },
          { $ref: '#/channels/feed/messages/heartbeat' },
        ],
      },
    },
    components: {
      messages: {
        Snapshot: {
          name: 'SNAPSHOT',
          title: 'Full book snapshot',
          summary:
            'Sent on connect and after a reseed: the entire book of every pair. The client replaces ' +
            'pair state wholesale with the same upsert code that applies deltas.',
          payload: frameSchema('SNAPSHOT', recordArray),
        },
        Delta: {
          name: 'DELTA',
          title: 'Level updates of one tick',
          summary: 'All level changes accumulated during one server tick, sequenced densely.',
          payload: frameSchema('DELTA', recordArray),
        },
        Heartbeat: {
          name: 'HEARTBEAT',
          title: 'Silence made explicit',
          summary:
            'No records; `firstSeq` holds the last assigned seq so loss is detectable even when the ' +
            'market is quiet.',
          payload: frameSchema(
            'HEARTBEAT',
            { type: 'array', maxItems: 0 },
            { count: { type: 'integer', const: 0 } },
          ),
        },
      },
      schemas: {
        WireRecord: {
          ...fromZod(wireRecordSchema),
          description:
            'Full upsert of one book level. `price` is an integer in pipettes (ADR-06); `size` is ' +
            'thousands of base currency, 0 = the level disappeared; `pairId` indexes the instrument ' +
            'catalogue served by the cold plane.',
        },
      },
    },
  };
}
