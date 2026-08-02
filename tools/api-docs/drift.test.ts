import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildAsyncApi, buildOpenApi } from './spec';

// Docs move with code as a build guarantee: if a schema changes and the
// committed documents were not regenerated, verify goes red.

function committed(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../apps/web/public/docs/${name}`, import.meta.url), 'utf8'));
}

describe('generated API docs are current (run `pnpm docs:api` after contract changes)', () => {
  it('openapi.json matches the domain schemas', () => {
    expect(committed('openapi.json')).toEqual(buildOpenApi());
  });

  it('asyncapi.json matches the protocol schemas', () => {
    expect(committed('asyncapi.json')).toEqual(buildAsyncApi());
  });
});
