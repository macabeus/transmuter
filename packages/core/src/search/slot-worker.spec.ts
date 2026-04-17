/**
 * End-to-end spec for the slot worker. Spawns a real Bun Worker and exercises
 * the init → job round-trip against the entity-item-drop fixture (agbcc, ARM
 * Thumb, no Wine). The goal is to confirm:
 *   1. The worker boots, imports NAPI + WASM dependencies, initialises the
 *      Scorer, and emits a `'ready'` message.
 *   2. At least one job completes with either a `'scored'` result (mutation
 *      compiled and scored) or a `'compile-error'` result (mutation broke
 *      something) — both are valid outcomes for a random mutation.
 *   3. The worker terminates cleanly.
 *
 * This spec is skipped when `agbcc` isn't built (i.e. setup-compilers.sh hasn't
 * run), matching the other real-compiler tests in the suite.
 */
import { accessSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { builtInRules } from '~/rules/built-in/index.js';

import type {
  WorkerInbound,
  WorkerInit,
  WorkerJob,
  WorkerOutbound,
} from './worker-protocol.js';

const FIXTURE_DIR = new URL('../../../../test-fixture/entity-item-drop/', import.meta.url).pathname;
const SHARED_DIR = new URL('../../../../test-fixture/shared/', import.meta.url).pathname;
const COMPILE_SH = join(SHARED_DIR, 'compile.sh');
const AGBCC_BINARY = new URL('../../../../compilers/agbcc/agbcc', import.meta.url).pathname;

function haveAgbcc(): boolean {
  try {
    accessSync(AGBCC_BINARY);
    return true;
  } catch {
    return false;
  }
}

const describeIfAgbcc = haveAgbcc() ? describe : describe.skip;

describeIfAgbcc('slot-worker (e2e, agbcc)', () => {
  it('boots, runs a job, and terminates cleanly', async () => {
    const sourcePrefix = readFileSync(join(SHARED_DIR, 'context.h'), 'utf-8');
    const baseSource = readFileSync(join(FIXTURE_DIR, 'base.c'), 'utf-8');
    const targetObjectPath = join(FIXTURE_DIR, 'target.o');

    const worker = new Worker(new URL('./slot-worker.ts', import.meta.url));

    const inbound: WorkerOutbound[] = [];
    worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
      inbound.push(ev.data);
    };
    const errorSpy: unknown[] = [];
    worker.onerror = (ev: ErrorEvent) => {
      errorSpy.push(ev.message);
    };

    function send(msg: WorkerInbound): void {
      worker.postMessage(msg);
    }

    function waitFor<T extends WorkerOutbound>(
      predicate: (msg: WorkerOutbound) => msg is T,
      timeoutMs = 10_000,
    ): Promise<T> {
      const existing = inbound.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<T>((resolve, reject) => {
        const start = performance.now();
        const original = worker.onmessage;
        const onTick = (ev: MessageEvent<WorkerOutbound>) => {
          original?.call(worker, ev);
          if (predicate(ev.data)) {
            worker.onmessage = original;
            resolve(ev.data);
          } else if (performance.now() - start > timeoutMs) {
            worker.onmessage = original;
            reject(new Error(`timed out waiting for predicate after ${timeoutMs} ms`));
          }
        };
        worker.onmessage = onTick;
        setTimeout(() => {
          worker.onmessage = original;
          reject(new Error(`timed out waiting for predicate after ${timeoutMs} ms`));
        }, timeoutMs);
      });
    }

    try {
      // 1. init
      const init: WorkerInit = {
        kind: 'init',
        slotId: 0,
        seed: 42,
        language: 'c',
        functionName: 'EntityItemDrop',
        mutationDepth: 1,
        sourcePrefix,
        enabledRuleIds: builtInRules.map((r) => r.id),
        ruleWeights: Object.fromEntries(builtInRules.map((r) => [r.id, r.defaultWeight])),
        adaptiveSnapshot: new Uint8Array(0),
        focusRegions: [],
        avoidRegions: [],
        adaptiveSelectorWindowSize: 500,
        compiler: {
          command: `${COMPILE_SH} {{inputPath}} {{outputPath}}`,
          cwd: FIXTURE_DIR,
        },
        scorer: {
          targetObjectPath,
          diffSettings: {},
        },
      };
      send(init);

      const ready = await waitFor(
        (m): m is Extract<WorkerOutbound, { kind: 'ready' }> => m.kind === 'ready',
        30_000,
      );
      expect(ready.slotId).toBe(0);
      expect(ready.initMs).toBeGreaterThan(0);

      // 2. one job — a random mutation against the base source
      const job: WorkerJob = {
        kind: 'job',
        jobId: 1,
        mutationTargetId: 'target-0',
        candidateSource: baseSource,
        breakdown: { total: 45, insert: 0, delete: 0, replace: 0, opMismatch: 5, argMismatch: 40 },
      };
      send(job);

      const result = await waitFor(
        (m): m is Extract<WorkerOutbound, { jobId?: number }> =>
          (m.kind === 'scored' ||
            m.kind === 'compile-error' ||
            m.kind === 'dedup' ||
            m.kind === 'no-mutation') &&
          m.jobId === 1,
        45_000,
      );
      expect(result.mutationTargetId).toBe('target-0');
      // The whole point of this spec is to prove the pipeline ran inside the
      // worker end-to-end. `no-mutation` and `dedup` skip compile entirely,
      // so force the test to fail loudly if we see them — it means the
      // mutation engine isn't producing anything or the source was already in
      // the dedup set, both of which would hide a real regression.
      expect(['scored', 'compile-error']).toContain(result.kind);
      if (result.kind === 'scored') {
        expect(result.ruleId).toBeTypeOf('string');
        expect(result.score).toBeTypeOf('number');
        expect(result.assembly.length).toBeGreaterThan(0);
        expect(result.timings.compile).toBeGreaterThan(0);
        expect(result.timings.score).toBeGreaterThan(0);
      } else {
        expect(result.timings.compile).toBeGreaterThan(0);
      }

      expect(errorSpy).toEqual([]);
    } finally {
      // 3. shutdown
      send({ kind: 'shutdown' });
      // Give the worker a moment to call process.exit, then force-terminate.
      await new Promise((r) => setTimeout(r, 100));
      worker.terminate();
    }
  }, 60_000);
});
