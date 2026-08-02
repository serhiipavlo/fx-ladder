import type { IncomingMessage, ServerResponse } from 'node:http';

import { pairIdOf, simGapBodySchema, simNewsBodySchema, simRateBodySchema, simSeedBodySchema } from '@fx/domain';

// Control plane v1 (architecture §8): /sim/* changes the behaviour of the
// world; every body is parsed by the shared domain schemas — a request either
// becomes a proven value or dies at the border with a field-level reason.
// Unvalidated data never reaches the simulator.

export interface TickStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  samples: number;
}

export interface SimStats {
  generated: number;
  sent: number;
  updatesPerSec: number;
  clients: number;
  uptimeMs: number;
  tick: TickStats;
}

/** What the control plane is allowed to do to the running server. */
export interface ControlDeps {
  reseed(seed: number): void;
  setRate(updatesPerSec: number): void;
  skipSeqs(count: number): void;
  news(pairId: number, pips: number, spreadX: number): void;
  stats(): SimStats;
}

/** Semantic rejection of a schema-valid body — reported like any field issue. */
export class FieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 16 * 1024;

interface BodySchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > MAX_BODY_BYTES) return null;
  }
  return text;
}

async function handlePost<T>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: BodySchema<T>,
  apply: (data: T) => void,
): Promise<void> {
  const text = await readBody(req);
  if (text === null) {
    sendJson(res, 400, { error: 'body too large' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === '' ? 'null' : text);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    sendJson(res, 400, {
      error: 'validation failed',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(body)',
        message: issue.message,
      })),
    });
    return;
  }
  try {
    apply(result.data);
  } catch (err) {
    if (err instanceof FieldError) {
      sendJson(res, 400, { error: 'validation failed', issues: [{ path: err.field, message: err.message }] });
      return;
    }
    throw err;
  }
  sendJson(res, 200, { ok: true });
}

/** Routes one /sim/* request; the caller has already matched the path prefix. */
export function handleSimRequest(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlDeps,
): void {
  const route = (method: string, handler: () => void): void => {
    if (req.method === method) {
      handler();
    } else {
      sendJson(res, 405, { error: `use ${method}` });
    }
  };

  switch (pathname) {
    case '/sim/seed':
      route('POST', () => void handlePost(req, res, simSeedBodySchema, (body) => deps.reseed(body.seed)));
      return;
    case '/sim/rate':
      route('POST', () => void handlePost(req, res, simRateBodySchema, (body) => deps.setRate(body.updatesPerSec)));
      return;
    case '/sim/gap':
      route('POST', () => void handlePost(req, res, simGapBodySchema, (body) => deps.skipSeqs(body.skipSeqs)));
      return;
    case '/sim/news':
      route('POST', () =>
        void handlePost(req, res, simNewsBodySchema, (body) => {
          const pairId = pairIdOf(body.pair);
          if (pairId < 0) throw new FieldError('pair', `unknown pair: ${body.pair}`);
          deps.news(pairId, body.pips, body.spreadX);
        }),
      );
      return;
    case '/sim/stats':
      route('GET', () => sendJson(res, 200, deps.stats()));
      return;
    default:
      sendJson(res, 404, { error: 'unknown control endpoint' });
  }
}

/** p-th percentile of a sample set (nearest-rank); 0 for an empty set. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}
