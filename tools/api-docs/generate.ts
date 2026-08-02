import { mkdirSync, writeFileSync } from 'node:fs';

import { buildAsyncApi, buildOpenApi } from './spec';

// Regenerates the committed API documents. The drift test fails the build
// whenever a schema changes without this having been re-run.
const outDir = new URL('../../apps/web/public/docs/', import.meta.url);
mkdirSync(outDir, { recursive: true });

writeFileSync(new URL('openapi.json', outDir), `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
writeFileSync(new URL('asyncapi.json', outDir), `${JSON.stringify(buildAsyncApi(), null, 2)}\n`);
console.log('wrote apps/web/public/docs/openapi.json and asyncapi.json');
