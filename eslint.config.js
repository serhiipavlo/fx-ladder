import { builtinModules } from 'node:module';

import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Dependency direction (architecture §4): domain ← {sim-core, protocol} ← apps,
// apps never import each other, and sim-core stays pure — no Node, no timers,
// no ambient time or randomness. These rules fail the build, not code review;
// tools/lint/boundaries.test.ts asserts each of them actually fires.

const nodeBuiltinBans = (message) =>
  builtinModules.flatMap((name) => [name, `node:${name}`]).map((name) => ({ name, message }));

// Bans both the package specifier (@fx/<dir>, incl. deep imports) and any
// relative path that climbs into the package's directory.
const boundaryRule = ({ forbid, message, nodeMessage }) => {
  const paths = forbid.map((dir) => ({ name: `@fx/${dir}`, message }));
  if (nodeMessage) paths.push(...nodeBuiltinBans(nodeMessage));
  const patterns = forbid.map((dir) => ({ group: [`**/${dir}/**`], message }));
  return ['error', { paths, patterns }];
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': boundaryRule({
        forbid: ['sim-core', 'protocol', 'feed-server', 'web'],
        message: 'domain depends on nothing in the workspace (architecture §4).',
        nodeMessage: 'domain is environment-neutral: no Node built-ins (architecture §4).',
      }),
    },
  },
  {
    files: ['packages/sim-core/**/*.ts'],
    rules: {
      'no-restricted-imports': boundaryRule({
        forbid: ['protocol', 'feed-server', 'web'],
        message: 'sim-core depends only on domain (architecture §4).',
        nodeMessage: 'sim-core is pure: no Node built-ins, no I/O (architecture §4).',
      }),
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'sim-core has no timers: time arrives as an argument of advance(now) (architecture §4).' },
        { name: 'setInterval', message: 'sim-core has no timers: time arrives as an argument of advance(now) (architecture §4).' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'No ambient time in sim-core: pass now as an argument (architecture §4).' },
        { object: 'Math', property: 'random', message: 'No ambient randomness in sim-core: use the seeded PRNG (architecture §5.1).' },
      ],
    },
  },
  {
    files: ['packages/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': boundaryRule({
        forbid: ['sim-core', 'feed-server', 'web'],
        message: 'protocol depends only on domain (architecture §4).',
        nodeMessage: 'protocol is consumed by the browser: no Node built-ins (architecture §4).',
      }),
    },
  },
  {
    files: ['apps/feed-server/**/*.ts'],
    rules: {
      'no-restricted-imports': boundaryRule({
        forbid: ['web'],
        message: 'Apps never import each other (architecture §4).',
      }),
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule({
        forbid: ['sim-core', 'feed-server'],
        message: 'web consumes protocol and domain only (architecture §4, ADR-03).',
      }),
    },
  },
  {
    // Node-run helper scripts at the repo root.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
