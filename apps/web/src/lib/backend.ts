// The deployed static site and the feed container live on different domains,
// so the backend origin arrives at build time via VITE_FEED_URL; locally it is
// empty and every path rides the Vite proxy on the page's own origin.

/** Resolves the origin every backend URL is built against. */
interface OriginResolver {
  (): string;
}

/** Builds an absolute backend URL from a path. */
interface PathUrlBuilder {
  (path: string): string;
}

/** Builds one fixed absolute URL. */
interface UrlBuilder {
  (): string;
}

const backendOrigin: OriginResolver = () => {
  const configured = import.meta.env.VITE_FEED_URL;
  return configured === undefined || configured === '' ? window.location.origin : configured;
};

/** Absolute URL of a backend fetch path (healthz, /sim/*, /api/*). */
export const backendUrl: PathUrlBuilder = (path) => new URL(path, backendOrigin()).toString();

export const healthzUrl: UrlBuilder = () => backendUrl('/healthz');

export const feedWsUrl: UrlBuilder = () => {
  const url = new URL('/feed', backendOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

export const graphqlWsUrl: UrlBuilder = () => {
  const url = new URL('/graphql', backendOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};
