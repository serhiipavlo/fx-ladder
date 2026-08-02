// The deployed static site and the feed container live on different domains,
// so the backend origin arrives at build time via VITE_FEED_URL; locally it is
// empty and every path rides the Vite proxy on the page's own origin.

function backendOrigin(): string {
  const configured = import.meta.env.VITE_FEED_URL;
  return configured === undefined || configured === '' ? window.location.origin : configured;
}

/** Absolute URL of a backend fetch path (healthz, /sim/*, /api/*). */
export function backendUrl(path: string): string {
  return new URL(path, backendOrigin()).toString();
}

export function healthzUrl(): string {
  return backendUrl('/healthz');
}

export function feedWsUrl(): string {
  const url = new URL('/feed', backendOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function graphqlWsUrl(): string {
  const url = new URL('/graphql', backendOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
