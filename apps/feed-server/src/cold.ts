import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { INSTRUMENTS, INSTRUMENTS_MAX_AGE_S } from '@fx/domain';

// The cold plane (architecture §7.2): one endpoint, and its whole point is
// the caching contract. ETag is the content's fingerprint; max-age hands the
// client an hour of silence; a conditional request that matches costs headers
// only. React Query's staleTime aligns with this max-age on the client so the
// two cache layers tell one story instead of fighting.

/** Strong ETag over the serialized value — change the catalogue, change the tag. */
export function etagOf(value: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(value)).digest('hex')}"`;
}

const BODY = JSON.stringify(INSTRUMENTS);
const ETAG = etagOf(INSTRUMENTS);
const CACHE_CONTROL = `public, max-age=${INSTRUMENTS_MAX_AGE_S}`;

export function handleInstruments(req: IncomingMessage, res: ServerResponse): void {
  const offered = (req.headers['if-none-match'] ?? '').split(',').map((tag) => tag.trim());
  if (offered.includes(ETAG)) {
    // Nothing changed since the version the client holds: headers only.
    res.writeHead(304, { ETag: ETAG, 'Cache-Control': CACHE_CONTROL });
    res.end();
    return;
  }
  res.writeHead(200, { ETag: ETAG, 'Cache-Control': CACHE_CONTROL, 'Content-Type': 'application/json' });
  res.end(BODY);
}
