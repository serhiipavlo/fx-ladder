import { build } from 'esbuild';

// Single-file ESM bundle: workspace packages and ws (pure JS) are compiled in,
// so the runtime image ships one file and no node_modules.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/server.mjs',
  sourcemap: true,
  // Optional native accelerators ws probes for inside try/catch; absent at
  // runtime the pure-JS path is used.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    // Bundled CJS (ws) may still call require() for the externals above.
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});
