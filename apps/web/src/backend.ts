// The deployed static site and the feed container live on different domains,
// so the backend origin arrives at build time via VITE_FEED_URL; locally it is
// empty and every path rides the Vite proxy on the page's own origin.

function backendOrigin(): string {
  const configured = import.meta.env.VITE_FEED_URL;
  return configured === undefined || configured === '' ? window.location.origin : configured;
}

export function healthzUrl(): string {
  return new URL('/healthz', backendOrigin()).toString();
}

export function feedWsUrl(): string {
  const url = new URL('/feed', backendOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
