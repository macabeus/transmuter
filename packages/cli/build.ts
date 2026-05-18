/// <reference types="bun" />
import { rm } from 'fs/promises';

import pkg from './package.json' with { type: 'json' };

await rm('dist', { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  target: 'bun',
  format: 'esm',
  sourcemap: 'linked',
  external: Object.keys(pkg.dependencies ?? {}),
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`  ${output.path.replace(process.cwd() + '/', '')}  ${(output.size / 1024).toFixed(1)} KB`);
}
