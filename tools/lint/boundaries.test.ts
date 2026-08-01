import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Executable fixture for T-0.0.2: proves the boundary and purity rules fire on
// a violating file and stay silent on a clean one. Each case lints a virtual
// file placed inside the package whose rules it exercises.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: `${repoRoot}${filePath}` });
  return (results[0]?.messages ?? []).map((m) => m.ruleId ?? '<parse error>');
}

describe('dependency direction', () => {
  it('sim-core must not import protocol', async () => {
    expect(await ruleIds('packages/sim-core/src/violation.ts', "export * from '@fx/protocol';")).toContain(
      'no-restricted-imports',
    );
  });

  it('sim-core must not reach protocol via a relative path', async () => {
    expect(
      await ruleIds('packages/sim-core/src/violation.ts', "export * from '../../protocol/src/index';"),
    ).toContain('no-restricted-imports');
  });

  it('domain must not import anything from the workspace', async () => {
    for (const pkg of ['@fx/sim-core', '@fx/protocol', '@fx/feed-server', '@fx/web']) {
      expect(await ruleIds('packages/domain/src/violation.ts', `export * from '${pkg}';`)).toContain(
        'no-restricted-imports',
      );
    }
  });

  it('protocol must not import sim-core', async () => {
    expect(await ruleIds('packages/protocol/src/violation.ts', "export * from '@fx/sim-core';")).toContain(
      'no-restricted-imports',
    );
  });

  it('apps must not import each other', async () => {
    expect(await ruleIds('apps/feed-server/src/violation.ts', "export * from '@fx/web';")).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds('apps/web/src/violation.ts', "export * from '@fx/feed-server';")).toContain(
      'no-restricted-imports',
    );
  });

  it('web must not import sim-core (ADR-03)', async () => {
    expect(await ruleIds('apps/web/src/violation.ts', "export * from '@fx/sim-core';")).toContain(
      'no-restricted-imports',
    );
  });
});

describe('sim-core purity', () => {
  it('bans Node built-ins, prefixed or bare', async () => {
    expect(await ruleIds('packages/sim-core/src/violation.ts', "import fs from 'node:fs';\nexport { fs };")).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds('packages/sim-core/src/violation.ts', "import fs from 'fs';\nexport { fs };")).toContain(
      'no-restricted-imports',
    );
  });

  it('bans Date.now', async () => {
    expect(await ruleIds('packages/sim-core/src/violation.ts', 'export const t = Date.now();')).toContain(
      'no-restricted-properties',
    );
  });

  it('bans Math.random', async () => {
    expect(await ruleIds('packages/sim-core/src/violation.ts', 'export const r = Math.random();')).toContain(
      'no-restricted-properties',
    );
  });

  it('bans setTimeout and setInterval', async () => {
    expect(
      await ruleIds('packages/sim-core/src/violation.ts', 'export const id = setTimeout(() => undefined, 1);'),
    ).toContain('no-restricted-globals');
    expect(
      await ruleIds('packages/sim-core/src/violation.ts', 'export const id = setInterval(() => undefined, 1);'),
    ).toContain('no-restricted-globals');
  });
});

describe('clean code stays clean', () => {
  it('sim-core may import domain and use injected time', async () => {
    const code = "import { PKG } from '@fx/domain';\nexport const tick = (now: number) => `${PKG}:${now}`;\n";
    expect(await ruleIds('packages/sim-core/src/clean.ts', code)).toEqual([]);
  });

  it('feed-server may import Node built-ins', async () => {
    const code = "import { createServer } from 'node:http';\nexport { createServer };\n";
    expect(await ruleIds('apps/feed-server/src/clean.ts', code)).toEqual([]);
  });
});
