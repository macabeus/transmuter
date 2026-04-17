import { defineConfig } from 'tsup';

export default defineConfig({
  // `slot-worker` is the entry point loaded by `new Worker(...)` in the
  // WorkerOrchestrator; it must ship as its own .js file so Bun can load it
  // from the built artefact.
  entry: ['src/index.ts', 'src/search/slot-worker.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.build.json',
});
