/**
 * Per-worker lifecycle spec for the slot worker. Spawns real Bun Workers
 * against the entity-item-drop fixture (agbcc, ARM Thumb, no Wine).
 *
 * Coverage is intentionally narrow — boot / error / job-round-trip /
 * shutdown. Full orchestrator behaviors (stop conditions, fork lifecycle,
 * compilation-error events, determinism, ...) live in `mutation-search.spec.ts`,
 * which exercises the same worker via the public API with real components.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtInRules } from '~/rules/built-in/index.js';

import type { WorkerInbound, WorkerInit, WorkerJob, WorkerOutbound } from './worker-protocol.js';

const FIXTURE_DIR = new URL('../../../../test-fixture/entity-item-drop/', import.meta.url).pathname;
const SHARED_DIR = new URL('../../../../test-fixture/shared/', import.meta.url).pathname;
const COMPILE_SH = join(SHARED_DIR, 'compile.sh');

const sourcePrefix = readFileSync(join(SHARED_DIR, 'context.h'), 'utf-8');
const baseSource = readFileSync(join(FIXTURE_DIR, 'base.c'), 'utf-8');
const targetObjectPath = join(FIXTURE_DIR, 'target.o');

function makeInit(overrides: Partial<WorkerInit> = {}): WorkerInit {
  return {
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
    compiler: { command: `${COMPILE_SH} {{inputPath}} {{outputPath}}`, cwd: FIXTURE_DIR },
    scorer: { targetObjectPath, diffSettings: {} },
    ...overrides,
  };
}

interface Harness {
  worker: Worker;
  events: WorkerOutbound[];
  send: (msg: WorkerInbound) => void;
  waitFor: <T extends WorkerOutbound>(predicate: (m: WorkerOutbound) => m is T, timeoutMs?: number) => Promise<T>;
  /** Drain the worker — sends shutdown and lets the worker run its cleanup. */
  shutdown: () => Promise<void>;
}

function makeHarness(): Harness {
  const worker = new Worker(new URL('./slot-worker.ts', import.meta.url));
  const events: WorkerOutbound[] = [];

  worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
    events.push(ev.data);
  };

  function send(msg: WorkerInbound): void {
    worker.postMessage(msg);
  }

  function waitFor<T extends WorkerOutbound>(predicate: (m: WorkerOutbound) => m is T, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const previous = worker.onmessage;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        worker.onmessage = previous;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
      const handler = (ev: MessageEvent<WorkerOutbound>) => {
        previous?.call(worker, ev);
        if (predicate(ev.data)) {
          cleanup();
          resolve(ev.data);
        }
      };
      worker.onmessage = handler;
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for predicate after ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  async function shutdown(): Promise<void> {
    send({ kind: 'shutdown' });
    // Match the production shutdown contract: unref the worker so vitest can
    // exit even if the worker is still finalizing. `terminate()` is avoided
    // because Bun can SIGILL the main process after the worker has spawned
    // compile subprocesses or loaded objdiff-wasm.
    await new Promise((r) => setTimeout(r, 200));
    worker.unref();
  }

  return { worker, events, send, waitFor, shutdown };
}

describe('slot-worker', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  describe('boot', () => {
    it('emits ready with a positive initMs after a successful init', async () => {
      harness.send(makeInit());

      const ready = await harness.waitFor((m): m is Extract<WorkerOutbound, { kind: 'ready' }> => m.kind === 'ready');
      expect(ready.slotId).toBe(0);
      expect(ready.initMs).toBeGreaterThan(0);
    });

    it('emits a fatal error event when init fails', async () => {
      // Bad targetObjectPath — Scorer.init will throw when it tries to read the file.
      harness.send(makeInit({ scorer: { targetObjectPath: '/nonexistent/target.o', diffSettings: {} } }));

      const err = await harness.waitFor((m): m is Extract<WorkerOutbound, { kind: 'error' }> => m.kind === 'error');
      expect(err.fatal).toBe(true);
      expect(err.error.length).toBeGreaterThan(0);
    });
  });

  describe('jobs', () => {
    it('emits a non-fatal error event when a job arrives before init', async () => {
      const job: WorkerJob = {
        kind: 'job',
        jobId: 1,
        mutationTargetId: 'target-0',
        candidateSource: baseSource,
        breakdown: { total: 1, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      };
      harness.send(job);

      const err = await harness.waitFor((m): m is Extract<WorkerOutbound, { kind: 'error' }> => m.kind === 'error');
      expect(err.fatal).toBe(false);
      expect(err.jobId).toBe(1);
      expect(err.error).toMatch(/before init/i);
    });

    it('round-trips a job: init → job → result with matching jobId', async () => {
      harness.send(makeInit());
      await harness.waitFor((m): m is Extract<WorkerOutbound, { kind: 'ready' }> => m.kind === 'ready');

      const job: WorkerJob = {
        kind: 'job',
        jobId: 7,
        mutationTargetId: 'target-0',
        candidateSource: baseSource,
        breakdown: { total: 45, insert: 0, delete: 0, replace: 0, opMismatch: 5, argMismatch: 40 },
      };
      harness.send(job);

      const result = await harness.waitFor(
        (m): m is Extract<WorkerOutbound, { kind: 'scored' | 'compile-error' | 'dedup' | 'no-mutation' }> =>
          (m.kind === 'scored' || m.kind === 'compile-error' || m.kind === 'dedup' || m.kind === 'no-mutation') &&
          m.jobId === 7,
        45_000,
      );
      // no-mutation and dedup skip compile entirely. Either is technically valid for a
      // random mutation but hides regressions in the pipeline, so fail loudly if we see them.
      expect(['scored', 'compile-error']).toContain(result.kind);
      expect(result.timings.compile ?? 0).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('shutdown', () => {
    it('aborts an in-flight job cleanly without raising a fatal error', async () => {
      // Real contract: shutdown arrives while a job is in flight. The
      // worker's abortController kills the compile subprocess; the in-flight
      // job comes back as compile-error (error: 'Aborted'), and the worker
      // itself does NOT emit a fatal error.
      harness.send(makeInit());
      await harness.waitFor((m): m is Extract<WorkerOutbound, { kind: 'ready' }> => m.kind === 'ready');

      harness.send({
        kind: 'job',
        jobId: 42,
        mutationTargetId: 'target-0',
        candidateSource: baseSource,
        breakdown: { total: 1, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      // Race a shutdown against the in-flight compile.
      harness.send({ kind: 'shutdown' });

      // Give the worker enough time to finish draining the compile + run its cleanup.
      await new Promise((r) => setTimeout(r, 1500));

      const fatals = harness.events.filter(
        (e): e is Extract<WorkerOutbound, { kind: 'error' }> => e.kind === 'error' && e.fatal,
      );
      expect(fatals).toEqual([]);
    });
  });
});
