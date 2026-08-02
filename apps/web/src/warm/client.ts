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

export function createWarmClient(): ApolloClient {
  const link = new GraphQLWsLink(
    createClient({
      url: graphqlWsUrl(),
      lazy: true,
      shouldRetry: () => true,
      retryAttempts: Infinity,
    }),
  );
  return new ApolloClient({ link, cache: new InMemoryCache() });
}
