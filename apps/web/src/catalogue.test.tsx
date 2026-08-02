// @vitest-environment jsdom
import { INSTRUMENTS } from '@fx/domain';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { instrumentsQueryOptions, resetCatalogueCache } from './catalogue';

const ETAG = '"catalogue-v1"';
const seen: Array<{ ifNoneMatch: string | null }> = [];

const server = setupServer(
  http.get('*/api/instruments', ({ request }) => {
    const ifNoneMatch = request.headers.get('if-none-match');
    seen.push({ ifNoneMatch });
    if (ifNoneMatch === ETAG) {
      return new HttpResponse(null, { status: 304, headers: { ETag: ETAG } });
    }
    return HttpResponse.json(INSTRUMENTS, { headers: { ETag: ETAG } });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  seen.length = 0;
  resetCatalogueCache();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('catalogue via React Query (done-when of T-0.3.7)', () => {
  it('a remount inside the freshness window issues no network request', async () => {
    const client = new QueryClient();
    const wrapper = makeWrapper(client);

    const first = renderHook(() => useQuery(instrumentsQueryOptions), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ifNoneMatch).toBeNull(); // nothing to revalidate yet
    first.unmount();

    // Same client, new mount, still inside staleTime (aligned to max-age):
    // the cache answers, the network stays silent (§7.2).
    const second = renderHook(() => useQuery(instrumentsQueryOptions), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(second.result.current.data).toEqual(INSTRUMENTS);
    expect(seen).toHaveLength(1);
    second.unmount();
  });

  it('after expiry the refetch is conditional and a 304 keeps the data', async () => {
    const client = new QueryClient();
    const wrapper = makeWrapper(client);

    const hook = renderHook(() => useQuery(instrumentsQueryOptions), { wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(seen).toHaveLength(1);

    // Expire the window and refetch: the request must carry the held ETag and
    // the 304 answer must leave the data intact.
    await client.invalidateQueries({ queryKey: instrumentsQueryOptions.queryKey });
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.ifNoneMatch).toBe(ETAG);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toEqual(INSTRUMENTS);
    hook.unmount();
  });
});
