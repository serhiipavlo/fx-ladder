import { INSTRUMENTS, INSTRUMENTS_MAX_AGE_S, type Instrument } from '@fx/domain';

import { backendUrl } from './backend';

// The cold plane's client half (§7.2): the catalogue rides React Query with
// staleTime aligned to the server's max-age — both sides read the same domain
// constant, so the two cache layers tell one story by construction. The
// conditional revalidation is explicit: we keep the last ETag and send
// If-None-Match ourselves, so a refetch after expiry costs headers (304) —
// observable in DevTools and assertable in tests, not hidden in a browser
// cache jsdom does not have.

let revalidation: { etag: string; body: Instrument[] } | null = null;

export async function fetchInstruments(): Promise<Instrument[]> {
  const headers: Record<string, string> = {};
  if (revalidation !== null) headers['If-None-Match'] = revalidation.etag;

  const res = await fetch(backendUrl('/api/instruments'), { headers });
  if (res.status === 304 && revalidation !== null) return revalidation.body;
  if (!res.ok) throw new Error(`instruments: HTTP ${res.status}`);

  const body = (await res.json()) as Instrument[];
  const etag = res.headers.get('etag');
  if (etag !== null) revalidation = { etag, body };
  return body;
}

/** Test hook: forget the held ETag so runs stay independent. */
export function resetCatalogueCache(): void {
  revalidation = null;
}

export const instrumentsQueryOptions = {
  queryKey: ['instruments'] as const,
  queryFn: fetchInstruments,
  /** Aligned with the server's Cache-Control: max-age (§7.2) — one shared constant. */
  staleTime: INSTRUMENTS_MAX_AGE_S * 1000,
  /** The board renders instantly from the built-in copy while the canonical one arrives. */
  placeholderData: INSTRUMENTS as Instrument[],
};
