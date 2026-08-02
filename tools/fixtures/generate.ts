import { mkdirSync, writeFileSync } from 'node:fs';

import { FIXTURES } from './build';

const outDir = new URL('../../packages/protocol/fixtures/', import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const { file, build } of FIXTURES) {
  writeFileSync(new URL(file, outDir), `${JSON.stringify(build(), null, 2)}\n`);
  console.log(`wrote packages/protocol/fixtures/${file}`);
}
