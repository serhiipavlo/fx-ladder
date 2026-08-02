import { ApolloClient, InMemoryCache } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';

import { graphqlWsUrl } from '../backend';

// The warm plane's client half (architecture §7.3). ALL operations — query,
// mutation, subscription — ride this single WebSocket on purpose (ADR-05):
// few operations, nothing cacheable enough to matter, and every extra moving
// part has a price. In a production system THIS is where the HTTP/WS split
// link would live — queries and mutations over HTTP for cacheability and
// standard load-balancer semantics, the WS reserved for subscriptions.
//
// graphql-ws re-dials a dropped socket and re-executes the active operations
// by itself; what it cannot know is that events fired while nobody listened.
// onReconnect is the hook the reconciliation hangs from (T-0.4.8): fired
// after the connection is RE-acknowledged, never on the first connect.

export interface WarmConnection {
  client: ApolloClient;
  /** Registers a listener for post-drop reconnections; returns the unsubscribe. */
  onReconnect(listener: () => void): () => void;
}

export function createWarmClient(): WarmConnection {
  const reconnectListeners = new Set<() => void>();
  const link = new GraphQLWsLink(
    createClient({
      url: graphqlWsUrl(),
      lazy: true,
      shouldRetry: () => true,
      retryAttempts: Infinity,
      on: {
        connected: (_socket, _payload, wasRetry) => {
          if (!wasRetry) return;
          for (const listener of reconnectListeners) listener();
        },
      },
    }),
  );
  return {
    client: new ApolloClient({ link, cache: new InMemoryCache() }),
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
  };
}
