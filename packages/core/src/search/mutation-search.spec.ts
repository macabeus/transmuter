/**
 * End-to-end MutationSearch behaviors. Exercises the full pipeline (Pool +
 * orchestrator + real Bun Workers + real compiler subprocesses + real
 * objdiff-wasm scoring) through the public API.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { MutationSearch } from '~/search/mutation-search.js';
import type { MutationSearchEvent, MutationSearchResult } from '~/types.js';

const FADE_DIR = new URL('../../../../test-fixture/fade-out-controller/', import.meta.url).pathname;
const SHARED_DIR = new URL('../../../../test-fixture/shared/', import.meta.url).pathname;
const COMPILE_CMD = `${join(SHARED_DIR, 'compile.sh')} {{inputPath}} {{outputPath}}`;

const sourcePrefix = readFileSync(join(SHARED_DIR, 'context.h'), 'utf-8');
const fadeSource = readFileSync(join(FADE_DIR, 'base.c'), 'utf-8');
const fadeTarget = join(FADE_DIR, 'target.o');

interface RunResult {
  result: MutationSearchResult;
  events: MutationSearchEvent[];
}

/**
 * Configurable run over the fade-out-controller fixture. Defaults are tuned
 * for short, deterministic spec runs: concurrency=1 so the search trajectory
 * is reproducible at a fixed seed (per slot-orchestrator.ts docblock), and
 * maxCompiles caps wall time.
 */
async function runSearch(
  overrides: Partial<ConstructorParameters<typeof MutationSearch>[0]> = {},
  options: { signal?: AbortSignal } = {},
): Promise<RunResult> {
  const events: MutationSearchEvent[] = [];
  const search = new MutationSearch({
    source: fadeSource,
    language: 'c',
    functionName: 'FadeOutController',
    targetObjectPath: fadeTarget,
    compilerCommand: COMPILE_CMD,
    cwd: FADE_DIR,
    sourcePrefix,
    profile: 'agbcc',
    concurrency: 1,
    seed: 42,
    mutationDepth: 1,
    maxCompiles: 20,
    onEvent: (event) => events.push(event),
    signal: options.signal,
    ...overrides,
  });
  const result = await search.start();
  return { result, events };
}

describe('MutationSearch', () => {
  describe('initial sanity', () => {
    it('completes with reason "aborted" and emits an error when the initial compile fails', async () => {
      const { result, events } = await runSearch({ compilerCommand: 'bash -c "exit 1"' });

      expect(result.reason).toBe('aborted');
      expect(result.totalIterations).toBe(0);
      expect(events.some((e) => e.type === 'error' && /Initial compilation failed/i.test(e.message))).toBe(true);
      expect(events.some((e) => e.type === 'completed' && e.reason === 'aborted')).toBe(true);
      // No 'started' should be emitted when we never got past the genesis compile.
      expect(events.some((e) => e.type === 'started')).toBe(false);
    }, 30_000);

    it('completes with reason "aborted" and emits an error when the scorer cannot find the function', async () => {
      const { result, events } = await runSearch({ functionName: 'NoSuchFunction' });

      expect(result.reason).toBe('aborted');
      expect(result.totalIterations).toBe(0);
      expect(events.some((e) => e.type === 'error' && /not found/i.test(e.message))).toBe(true);
      expect(events.some((e) => e.type === 'started')).toBe(false);
    }, 30_000);
  });

  describe('stop conditions', () => {
    it('stops with reason "max-compiles" when maxCompiles is hit', async () => {
      const { result, events } = await runSearch({ maxCompiles: 5 });

      expect(result.reason).toBe('max-compiles');
      expect(events.some((e) => e.type === 'completed' && e.reason === 'max-compiles')).toBe(true);
      // The exact count is approximate (in-flight prefetch can overshoot), but
      // it must reach maxCompiles before the search stops.
      const scoredCount = events.filter((e) => e.type === 'scored').length;
      const errorCount = events.filter((e) => e.type === 'compilation-error').length;
      expect(scoredCount + errorCount).toBeGreaterThanOrEqual(5);
    }, 30_000);

    it('stops with reason "aborted" when the external signal aborts mid-run', async () => {
      const ctrl = new AbortController();
      const events: MutationSearchEvent[] = [];
      const search = new MutationSearch({
        source: fadeSource,
        language: 'c',
        functionName: 'FadeOutController',
        targetObjectPath: fadeTarget,
        compilerCommand: COMPILE_CMD,
        cwd: FADE_DIR,
        sourcePrefix,
        profile: 'agbcc',
        concurrency: 1,
        seed: 42,
        maxCompiles: 500, // high cap — we expect the abort to stop us first
        signal: ctrl.signal,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'scored' && !ctrl.signal.aborted) {
            ctrl.abort();
          }
        },
      });

      const result = await search.start();
      expect(result.reason).toBe('aborted');
      expect(events.some((e) => e.type === 'completed' && e.reason === 'aborted')).toBe(true);
    }, 30_000);
  });

  describe('events', () => {
    it('emits "started" exactly once before any compile-reaching event', async () => {
      const { events } = await runSearch();

      const startedIdx = events.findIndex((e) => e.type === 'started');
      const firstResultIdx = events.findIndex((e) => e.type === 'scored' || e.type === 'compilation-error');

      expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      // Fail loudly if the run produced no compile-reaching events — the
      // ordering claim would otherwise be vacuously true.
      expect(firstResultIdx).toBeGreaterThan(-1);
      expect(startedIdx).toBeLessThan(firstResultIdx);
    }, 30_000);

    it('emits a "scored" event for every successful compile+score', async () => {
      const { events } = await runSearch({ maxCompiles: 10 });

      const scored = events.filter((e): e is Extract<MutationSearchEvent, { type: 'scored' }> => e.type === 'scored');
      expect(scored.length).toBeGreaterThan(0);
      for (const event of scored) {
        expect(typeof event.score).toBe('number');
        expect(event.score).toBeGreaterThanOrEqual(0);
        expect(typeof event.iteration).toBe('number');
        expect(typeof event.ruleId).toBe('string');
      }
    }, 30_000);

    it('emits "forked" + "mutation-target-created" together when a mutation improves the score', async () => {
      // fade-out-controller is known to fork under agbcc with seed=42 within
      // a few dozen compiles. We don't assert exact counts — only that at
      // least one fork-pair appears, and that the pair is internally consistent.
      const { events } = await runSearch({ maxCompiles: 50 });

      const forks = events.filter((e): e is Extract<MutationSearchEvent, { type: 'forked' }> => e.type === 'forked');
      const targetCreations = events.filter(
        (e): e is Extract<MutationSearchEvent, { type: 'mutation-target-created' }> =>
          e.type === 'mutation-target-created' && e.origin === 'organic',
      );

      expect(forks.length).toBeGreaterThan(0);
      for (const fork of forks) {
        expect(fork.newScore).toBeLessThan(fork.oldScore);
        expect(fork.candidateId).not.toBe(fork.parentCandidateId);
      }

      // Each forked event must pair 1:1 with an organic mutation-target-created
      // event for the same (mutationTargetId, candidateId). Compare sorted
      // tuples directly so the assertion fails loudly on mismatch — no
      // per-element conditional access.
      const forkPairs = forks.map((f) => ({ mutationTargetId: f.mutationTargetId, candidateId: f.candidateId }));
      const creationPairs = targetCreations.map((t) => ({
        mutationTargetId: t.mutationTargetId,
        candidateId: t.candidateId,
      }));
      const sortByMtid = (a: { mutationTargetId: string }, b: { mutationTargetId: string }) =>
        a.mutationTargetId.localeCompare(b.mutationTargetId);
      expect([...creationPairs].sort(sortByMtid)).toEqual([...forkPairs].sort(sortByMtid));
    }, 60_000);

    it('emits "compilation-error" when a mutation breaks compilation', async () => {
      // Mutations occasionally produce ill-formed source; with 100 compiles
      // we expect at least one compile failure for this fixture under agbcc.
      const { events } = await runSearch({ maxCompiles: 100 });

      const errors = events.filter(
        (e): e is Extract<MutationSearchEvent, { type: 'compilation-error' }> => e.type === 'compilation-error',
      );
      expect(errors.length).toBeGreaterThan(0);
      for (const event of errors) {
        expect(typeof event.ruleId).toBe('string');
        expect(typeof event.mutationTargetId).toBe('string');
        expect(event.error.length).toBeGreaterThan(0);
      }
    }, 90_000);
  });

  describe('determinism', () => {
    it('two runs with the same seed at concurrency=1 produce the same best score and source', async () => {
      const a = await runSearch({ maxCompiles: 30 });
      const b = await runSearch({ maxCompiles: 30 });

      expect(b.result.bestScore).toBe(a.result.bestScore);
      expect(b.result.bestSource).toBe(a.result.bestSource);
      expect(b.result.totalIterations).toBe(a.result.totalIterations);
    }, 90_000);
  });
});
