/**
 * Slot orchestrator — spawns N Bun Workers, each running the full mutate →
 * dedup → compile → score pipeline in its own thread. Main thread owns: the
 * Pool, the authoritative AdaptiveSelector, event emission, and HTTP API side
 * effects.
 *
 * Determinism: with `concurrency === 1` + a fixed seed + `--max-compiles`,
 * runs are bit-identical across invocations. AdaptiveSelector rebroadcast is
 * iteration-counted (not wall-clock) so seeded runs stay reproducible. Above
 * N=1, worker-result ordering depends on real-time scheduling; use
 * `--concurrency 1` for reproducibility tests.
 *
 * See BUN_WORKERS_PLAN.md §3 and §6 for the architecture.
 */
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type { Language } from '~/language.js';
import type { Pool } from '~/pipeline/pool.js';
import type { AdaptiveSelector } from '~/rules/adaptive-selector.js';
import type { RuleRegistry } from '~/rules/registry.js';
import type {
  AssemblyScoreResult,
  AvoidRegionConstraint,
  FocusRegionConstraint,
  MutationSearchEvent,
  MutationSearchEventHandler,
} from '~/types.js';

import type { PhaseTimings, WorkerInit, WorkerJob, WorkerOutbound, WorkerResult } from './worker-protocol.js';

/** Options for SlotOrchestrator. */
export interface SlotOrchestratorOptions {
  pool: Pool;
  adaptiveSelector: AdaptiveSelector;
  registry: RuleRegistry;
  concurrency: number;
  seed: number;
  language: Language;
  functionName: string;
  mutationDepth: number;
  sourcePrefix: string;
  focusRegions: readonly FocusRegionConstraint[];
  avoidRegions: readonly AvoidRegionConstraint[];
  adaptiveSelectorWindowSize: number;
  compilerCommand: string;
  compilerCwd: string;
  targetObjectPath: string;
  diffSettings: Record<string, string>;
  /**
   * Stop after this many compile attempts (compiled + compile-errored
   * results). No-mutation and dedup early-exits do NOT count. Approximate
   * because in-flight prefetched jobs may overshoot.
   */
  maxCompiles: number;
  timeoutMs: number;
  statsInterval: number;
  onEvent: MutationSearchEventHandler;
  signal: AbortSignal;
  candidateFilter?: (source: string) => boolean;
  scoreTransform?: (source: string, asmResult: AssemblyScoreResult) => number;
  maxUnproductiveResults?: number;
  /**
   * Rebroadcast the authoritative AdaptiveSelector snapshot to all workers
   * every N results. Iteration-counted rather than wall-clock-timed so that
   * `--concurrency 1 --seed X --max-compiles Y` is bit-identical across
   * runs. Default: 100.
   */
  adaptiveRebroadcastEvery?: number;
  prefetchDepth?: number;
}

interface WorkerSlot {
  id: number;
  worker: Worker;
  pending: number;
  ready: Promise<void>;
}

interface SlotStats {
  compiled: number;
  errors: number;
  scorerFailures: number;
  deduped: number;
  noMutation: number;
}

/**
 * Per-phase wall-time totals, summed across every WorkerResult from every
 * worker. Units are milliseconds. Compared against the CPU budget
 * (wall × concurrency) to compute the Permuter-style percentage breakdown.
 */
interface PhaseTotals {
  mutate: number;
  parse: number;
  ruleApply: number;
  dedup: number;
  compile: number;
  score: number;
}

const GOLDEN_RATIO_U32 = 0x9e3779b1;

export class SlotOrchestrator {
  #opts: SlotOrchestratorOptions;
  #slots: WorkerSlot[] = [];
  #iteration = 0;
  #lastStatsIteration = 0;
  #startTime = 0;
  #paused = false;
  #perfectMatchFound = false;
  #resumeWaiters: (() => void)[] = [];
  #slotStats: SlotStats = { compiled: 0, errors: 0, scorerFailures: 0, deduped: 0, noMutation: 0 };
  #phaseTotals: PhaseTotals = { mutate: 0, parse: 0, ruleApply: 0, dedup: 0, compile: 0, score: 0 };
  #mutationDepth: number;
  #nextJobId = 0;
  #stopped = false;
  #runResolve: (() => void) | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;
  #lastRebroadcastIteration = 0;

  constructor(opts: SlotOrchestratorOptions) {
    this.#opts = opts;
    this.#mutationDepth = opts.mutationDepth;
  }

  async run(): Promise<void> {
    this.#startTime = Date.now();
    this.#iteration = 0;

    // Spawn + init + run loop all live inside a single try/finally so that
    // #shutdown() reliably tears down every spawned worker, even if init
    // fails partway through. Without this, a fatal error in any worker's
    // handleInit (e.g. Scorer.init() throwing) would propagate out of run()
    // and leak the other workers — the host process would stay alive on the
    // event loop until something forces it down.
    try {
      this.#spawnWorkers();
      await Promise.all(this.#slots.map((s) => s.ready));

      if (this.#opts.signal.aborted) {
        return;
      }

      this.#opts.signal.addEventListener(
        'abort',
        () => {
          this.#stopped = true;
          this.#wakeRunLoop();
        },
        { once: true },
      );

      if (Number.isFinite(this.#opts.timeoutMs)) {
        this.#stopTimer = setTimeout(() => {
          this.#stopped = true;
          this.#wakeRunLoop();
        }, this.#opts.timeoutMs);
      }

      await this.#runLoop();
    } finally {
      // Emit profile BEFORE shutting workers down; on some Bun versions the
      // process exits with a crash during worker.terminate() and any
      // post-shutdown work (including profile output) gets lost.
      this.#maybeEmitProfile();
      await this.#shutdown();
    }
  }

  #maybeEmitProfile(): void {
    if (!process.env.TRANSMUTER_PROFILE) {
      return;
    }
    const wall = (Date.now() - this.#startTime) / 1000;
    const s = this.#slotStats;
    const totalResults = this.#iteration;
    const cAtt = s.compiled + s.errors + s.scorerFailures;
    const summary = [
      `\n[TRANSMUTER_WORKER_PROFILE]`,
      `  wall=${wall.toFixed(2)}s  workers=${this.#opts.concurrency}  iter-total=${totalResults}  iter/s=${(totalResults / wall).toFixed(1)}`,
      `  scored=${s.compiled}  compile-errors=${s.errors}  scorer-failed=${s.scorerFailures}  dedup=${s.deduped}  no-mutation=${s.noMutation}`,
      `  compile-attempts/s=${(cAtt / wall).toFixed(2)}  successful-iter/s=${(s.compiled / wall).toFixed(2)}`,
      `  (compile rate ${((cAtt / totalResults) * 100).toFixed(1)}% of all results; no-mutation ${((s.noMutation / totalResults) * 100).toFixed(1)}%)`,
    ].join('\n');
    process.stderr.write(summary + '\n');

    // Per-phase breakdown — Permuter-style. Percentages are share of total
    // in-worker work time (mutate + dedup + compile + score, summed across
    // all workers). This is concurrency-agnostic: it shows where worker time
    // *goes*, regardless of prefetch interleaving or worker count. Latencies
    // are averaged over the iterations that actually executed that phase
    // (e.g. compile only runs on iterations that survived dedup).
    const p = this.#phaseTotals;
    const totalWorkMs = p.mutate + p.dedup + p.compile + p.score;
    const phaseCounts = {
      mutate: totalResults,
      dedup: totalResults - s.noMutation,
      compile: s.compiled + s.errors + s.scorerFailures,
      score: s.compiled + s.scorerFailures,
    };
    const fmt = (ms: number, count: number): string => {
      const pct = totalWorkMs > 0 ? (ms / totalWorkMs) * 100 : 0;
      const avg = count > 0 ? ms / count : 0;
      return `${(ms / 1000).toFixed(2)}s (${pct.toFixed(1)}%)  avg=${avg.toFixed(2)}ms × ${count}`;
    };
    const breakdown = [
      `  per-phase totals (sum across all workers, share of in-worker work time):`,
      `    mutate    = ${fmt(p.mutate, phaseCounts.mutate)}  [parse=${(p.parse / 1000).toFixed(2)}s, ruleApply=${(p.ruleApply / 1000).toFixed(2)}s]`,
      `    dedup     = ${fmt(p.dedup, phaseCounts.dedup)}`,
      `    compile   = ${fmt(p.compile, phaseCounts.compile)}`,
      `    score     = ${fmt(p.score, phaseCounts.score)}`,
      `  total work time (in-worker, summed across slots): ${(totalWorkMs / 1000).toFixed(2)}s` +
        ` over ${(wall * this.#opts.concurrency).toFixed(2)}s of cpu-budget` +
        ` (saturation=${((totalWorkMs / 1000 / (wall * this.#opts.concurrency)) * 100).toFixed(0)}%${
          totalWorkMs / 1000 > wall * this.#opts.concurrency
            ? ' — exceeds 100% because each worker overlaps multiple jobs via prefetch'
            : ''
        })`,
    ].join('\n');
    process.stderr.write(breakdown + '\n');
  }

  getIteration(): number {
    return this.#iteration;
  }

  getCompiledCount(): number {
    return this.#slotStats.compiled;
  }

  /**
   * Compile attempts so far (compiled + compile-errored + scorer-failed).
   * All three reached `compiler.compile()`, so all three count against
   * `maxCompiles`. Tracks `maxCompiles`.
   */
  getCompileAttempts(): number {
    return this.#slotStats.compiled + this.#slotStats.errors + this.#slotStats.scorerFailures;
  }

  getElapsed(): number {
    return Date.now() - this.#startTime;
  }

  signalPerfectMatch(): void {
    this.#perfectMatchFound = true;
    this.#stopped = true;
    this.#wakeRunLoop();
  }

  setMutationDepth(depth: number): void {
    this.#mutationDepth = depth;
    for (const slot of this.#slots) {
      slot.worker.postMessage({ kind: 'mutation-depth-updated', depth });
    }
  }

  getMutationDepth(): number {
    return this.#mutationDepth;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    for (const w of this.#resumeWaiters) {
      w();
    }
    this.#resumeWaiters = [];
    this.#wakeRunLoop();
  }

  setFocusConstraints(
    focusRegions: readonly FocusRegionConstraint[],
    avoidRegions: readonly AvoidRegionConstraint[],
  ): void {
    for (const slot of this.#slots) {
      slot.worker.postMessage({
        kind: 'focus-updated',
        focusRegions: [...focusRegions],
        avoidRegions: [...avoidRegions],
      });
    }
  }

  broadcastRules(): void {
    const enabled = this.#opts.registry
      .all()
      .filter((r) => this.#opts.registry.getWeight(r.id) > 0)
      .map((r) => r.id);
    const weights = this.#opts.registry.getAllWeights();
    for (const slot of this.#slots) {
      slot.worker.postMessage({ kind: 'rules-updated', enabledRuleIds: enabled, ruleWeights: weights });
    }
  }

  #spawnWorkers(): void {
    // Resolve the slot-worker entry two ways:
    //  - In tests (vitest running src/), the orchestrator lives alongside
    //    `slot-worker.ts`, so the sibling URL works.
    //  - In built dist, the orchestrator is bundled into `dist/index.js`
    //    while slot-worker is emitted separately as `dist/search/slot-worker.js`.
    //    The package.json `./slot-worker` export handles that case via
    //    `import.meta.resolve`.
    // We prefer the sibling URL when the file actually exists on disk;
    // `import.meta.resolve` returns a URL without verifying existence, so
    // checking the sibling first prevents resolving to a stale/missing dist
    // when running unbuilt sources.
    let workerUrl: URL;
    const siblingUrl = new URL('./slot-worker.js', import.meta.url);
    const siblingPath = fileURLToPath(siblingUrl).replace(/\.js$/, '.ts');
    if (existsSync(fileURLToPath(siblingUrl)) || existsSync(siblingPath)) {
      workerUrl = siblingUrl;
    } else {
      workerUrl = new URL(import.meta.resolve('@transmuter/core/slot-worker'));
    }
    for (let slotId = 0; slotId < this.#opts.concurrency; slotId++) {
      const worker = new Worker(workerUrl);
      const slot: WorkerSlot = {
        id: slotId,
        worker,
        pending: 0,
        ready: this.#initWorker(worker, slotId),
      };
      worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => this.#onMessage(slot, ev.data);
      worker.onerror = (ev: ErrorEvent) => {
        this.#emit({
          type: 'error',
          message: `worker ${slotId} error: ${ev.message}`,
        });
      };
      this.#slots.push(slot);
    }
  }

  #initWorker(worker: Worker, slotId: number): Promise<void> {
    const registry = this.#opts.registry;
    const enabled = registry
      .all()
      .filter((r) => registry.getWeight(r.id) > 0)
      .map((r) => r.id);
    const init: WorkerInit = {
      kind: 'init',
      slotId,
      seed: this.#deriveSeed(slotId),
      language: this.#opts.language,
      functionName: this.#opts.functionName,
      mutationDepth: this.#mutationDepth,
      sourcePrefix: this.#opts.sourcePrefix,
      enabledRuleIds: enabled,
      ruleWeights: registry.getAllWeights(),
      adaptiveSnapshot: this.#opts.adaptiveSelector.serialize(),
      focusRegions: this.#opts.focusRegions,
      avoidRegions: this.#opts.avoidRegions,
      adaptiveSelectorWindowSize: this.#opts.adaptiveSelectorWindowSize,
      compiler: { command: this.#opts.compilerCommand, cwd: this.#opts.compilerCwd },
      scorer: { targetObjectPath: this.#opts.targetObjectPath, diffSettings: this.#opts.diffSettings },
    };
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        worker.removeEventListener('message', handler);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
      const handler = (ev: MessageEvent<WorkerOutbound>) => {
        const msg = ev.data;
        if (msg.kind === 'ready' && msg.slotId === slotId) {
          cleanup();
          resolve();
        } else if (msg.kind === 'error' && msg.fatal) {
          cleanup();
          reject(new Error(`worker ${slotId} fatal init error: ${msg.error}`));
        }
      };
      // Register the listener BEFORE posting init so we don't miss a fatal
      // error fired synchronously during worker bootstrap.
      worker.addEventListener('message', handler);
      // Fallback so a silent worker doesn't hang the whole pool forever.
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`worker ${slotId} did not become ready in 30s`));
      }, 30_000);

      worker.postMessage(init);
    });
  }

  #deriveSeed(slotId: number): number {
    // Deterministic: same base seed + slotId → same worker seed.
    // Multiplier is the 32-bit golden-ratio constant — well-distributed
    // multiplicative hash mixer.
    return (this.#opts.seed ^ (slotId * GOLDEN_RATIO_U32)) >>> 0;
  }

  async #runLoop(): Promise<void> {
    while (!this.#shouldStop()) {
      if (this.#paused) {
        await new Promise<void>((r) => this.#resumeWaiters.push(r));
        continue;
      }

      const filled = this.#topUpWorkers();
      if (!filled && !this.#allIdle()) {
        // Workers are busy; wait for a result to free a slot.
        await new Promise<void>((resolve) => {
          this.#runResolve = resolve;
        });
        this.#runResolve = null;
      } else if (!filled && this.#allIdle()) {
        // Pool empty and nothing in flight — we are done.
        break;
      }
    }
  }

  #topUpWorkers(): boolean {
    if (this.#shouldStop()) {
      return false;
    }
    const prefetch = this.#opts.prefetchDepth ?? 2;
    let postedAny = false;
    // Pool selection is invalid when the pool has no active targets. Checking
    // once up-front avoids reallocating the active-targets list on every job
    // we post. If a target gets disabled mid-fill, the resulting `select()`
    // would still return *something* — the candidateFilter / worker side
    // sorts it out.
    if (this.#opts.pool.getActiveTargets().length === 0) {
      return postedAny;
    }
    for (const slot of this.#slots) {
      while (slot.pending < prefetch) {
        if (this.#shouldStop()) {
          return postedAny;
        }

        const target = this.#opts.pool.select();
        const headCandidate = this.#opts.pool.getCandidate(target.candidateId);
        if (!headCandidate) {
          continue;
        }

        const jobId = ++this.#nextJobId;
        const job: WorkerJob = {
          kind: 'job',
          jobId,
          mutationTargetId: target.id,
          candidateSource: headCandidate.source,
          breakdown: headCandidate.breakdown,
        };
        slot.pending++;
        slot.worker.postMessage(job);
        postedAny = true;
      }
    }
    return postedAny;
  }

  #allIdle(): boolean {
    return this.#slots.every((s) => s.pending === 0);
  }

  #wakeRunLoop(): void {
    if (this.#runResolve) {
      this.#runResolve();
      this.#runResolve = null;
    }
  }

  #shouldStop(): boolean {
    if (this.#stopped) {
      return true;
    }
    if (this.#perfectMatchFound) {
      return true;
    }
    if (this.#opts.signal.aborted) {
      return true;
    }
    // maxCompiles counts attempts that actually reached `compiler.compile()`
    // i.e. not killed by no-mutation or dedup
    if (this.getCompileAttempts() >= this.#opts.maxCompiles) {
      return true;
    }
    if (Date.now() - this.#startTime >= this.#opts.timeoutMs) {
      return true;
    }
    if (
      this.#opts.maxUnproductiveResults !== undefined &&
      this.#iteration > 0 &&
      this.#slotStats.compiled === 0 &&
      this.#iteration >= this.#opts.maxUnproductiveResults
    ) {
      return true;
    }
    return false;
  }

  #onMessage(slot: WorkerSlot, msg: WorkerOutbound): void {
    if (msg.kind === 'ready' || msg.kind === 'error') {
      if (msg.kind === 'error') {
        // Free the slot if the error names a jobId — otherwise prefetch leaks
        // one entry per job-time error and the slot stops accepting work.
        if (msg.jobId !== undefined) {
          slot.pending = Math.max(0, slot.pending - 1);
          this.#wakeRunLoop();
        }
        this.#emit({ type: 'error', message: `worker ${msg.slotId} error: ${msg.error}` });
      }
      return;
    }

    // All remaining kinds are WorkerResult.
    const result = msg as WorkerResult;
    slot.pending = Math.max(0, slot.pending - 1);

    if (!this.#shouldStop()) {
      this.#iteration++;
      this.#handleResult(result);
    }

    // Emit periodic stats.
    if (this.#iteration - this.#lastStatsIteration >= this.#opts.statsInterval) {
      this.#lastStatsIteration = this.#iteration;
      this.#emitStats(this.#iteration);
    }

    // Iteration-counted adaptive rebroadcast. Keeps each worker's Thompson
    // state in sync with main's authoritative copy without wall-clock timing
    // (which would break determinism under fixed --seed). Workers don't
    // record locally — main owns the canonical selector — so without this
    // rebroadcast the worker's selector stays at its initial snapshot and
    // rule selection becomes non-adaptive. Runs for all concurrency values.
    const every = this.#opts.adaptiveRebroadcastEvery ?? 100;
    if (every > 0 && this.#iteration - this.#lastRebroadcastIteration >= every) {
      this.#lastRebroadcastIteration = this.#iteration;
      this.#broadcastAdaptiveSnapshot();
    }

    // Always wake the run loop so top-up can proceed.
    this.#wakeRunLoop();
  }

  #handleResult(result: WorkerResult): void {
    this.#accumulatePhases(result.timings);
    switch (result.kind) {
      case 'no-mutation':
        this.#slotStats.noMutation++;
        return;
      case 'dedup':
        this.#slotStats.deduped++;
        return;
      case 'compile-error': {
        this.#slotStats.errors++;
        this.#opts.pool.recordFailure(result.mutationTargetId);
        this.#emit({
          type: 'compilation-error',
          mutationTargetId: result.mutationTargetId,
          ruleId: result.ruleId,
          error: result.error,
        });
        return;
      }
      case 'scorer-failed': {
        // Compile succeeded; only scoring failed. Counts against maxCompiles
        // (compiler.compile() did run) but is NOT a compile failure: don't
        // bump errors and don't recordFailure on the target — the rule
        // didn't break compile, the symbol just wasn't readable.
        this.#slotStats.scorerFailures++;
        this.#emit({
          type: 'scorer-failed',
          mutationTargetId: result.mutationTargetId,
          ruleId: result.ruleId,
          error: result.error,
        });
        return;
      }
      case 'scored': {
        // The compile and score both ran in the worker, so this attempt
        // counts against `maxCompiles` regardless of whether the main-side
        // candidate filter accepts the result.
        this.#slotStats.compiled++;

        // Main-side candidate filter (applied to the mutated source since we
        // couldn't evaluate it before dispatching the job).
        if (this.#opts.candidateFilter && !this.#opts.candidateFilter(result.mutatedSource)) {
          return;
        }

        const asmResult: AssemblyScoreResult = {
          score: result.score,
          breakdown: result.breakdown,
          assembly: result.assembly,
          assemblyDiff: result.assemblyDiff,
        };
        const finalScore = this.#opts.scoreTransform
          ? this.#opts.scoreTransform(result.mutatedSource, asmResult)
          : result.score;

        // Use getTarget (not getActiveTargets) — a target may have been
        // disabled via the HTTP API while this job was in flight, and we
        // still want the correct parentCandidateId for the fork event.
        const parentTarget = this.#opts.pool.getTarget(result.mutationTargetId);
        const reported = this.#opts.pool.report(
          {
            mutationTargetId: result.mutationTargetId,
            source: result.mutatedSource,
            score: finalScore,
            breakdown: result.breakdown,
            ruleId: result.ruleId,
            location: result.location,
            assembly: result.assembly,
            assemblyDiff: result.assemblyDiff,
          },
          this.#iteration,
        );

        this.#emit({
          type: 'scored',
          iteration: this.#iteration,
          score: finalScore,
          ruleId: result.ruleId,
          mutationTargetId: result.mutationTargetId,
        });

        const forked = reported.forked;
        if (forked) {
          const parentCandidate = parentTarget ? this.#opts.pool.getCandidate(parentTarget.candidateId) : undefined;
          this.#emit({
            type: 'forked',
            iteration: this.#iteration,
            parentCandidateId: parentCandidate?.id ?? 'unknown',
            candidateId: forked.candidate.id,
            mutationTargetId: forked.mutationTarget.id,
            oldScore: parentCandidate?.score ?? finalScore,
            newScore: finalScore,
            source: result.mutatedSource,
            ruleId: result.ruleId,
            location: result.location,
            assembly: result.assembly,
            assemblyDiff: result.assemblyDiff,
            breakdown: result.breakdown,
          });
          this.#emit({
            type: 'mutation-target-created',
            mutationTargetId: forked.mutationTarget.id,
            candidateId: forked.candidate.id,
            score: finalScore,
            origin: 'organic',
          });
        }

        this.#opts.adaptiveSelector.record(result.mutationTargetId, result.ruleId, !!forked);
        if (forked) {
          this.#opts.adaptiveSelector.fork(result.mutationTargetId, forked.mutationTarget.id);
        }

        if (finalScore === 0) {
          this.#perfectMatchFound = true;
          this.#stopped = true;
          this.#emit({
            type: 'perfect-match',
            iteration: this.#iteration,
            source: result.mutatedSource,
            candidateId: forked?.candidate.id ?? 'unknown',
          });
        }
        return;
      }
    }
  }

  #accumulatePhases(t: PhaseTimings): void {
    const p = this.#phaseTotals;
    p.mutate += t.mutate;
    p.parse += t.parse;
    p.ruleApply += t.ruleApply;
    if (t.dedup !== undefined) {
      p.dedup += t.dedup;
    }
    if (t.compile !== undefined) {
      p.compile += t.compile;
    }
    if (t.score !== undefined) {
      p.score += t.score;
    }
  }

  #emit(event: MutationSearchEvent): void {
    try {
      this.#opts.onEvent(event);
    } catch {
      // Swallow consumer errors.
    }
  }

  #emitStats(iteration: number): void {
    const stats = this.#opts.pool.getStats();
    this.#emit({
      type: 'stats',
      iteration,
      elapsed: this.getElapsed(),
      targets: stats.targets,
      bestScore: stats.bestScore,
      candidateCount: stats.candidateCount,
      compiled: this.#slotStats.compiled,
      errors: this.#slotStats.errors,
      deduped: this.#slotStats.deduped,
      rulesUsed: {},
    });
  }

  #broadcastAdaptiveSnapshot(): void {
    const snapshot = this.#opts.adaptiveSelector.serialize();
    for (const slot of this.#slots) {
      slot.worker.postMessage({ kind: 'adaptive-snapshot', snapshot });
    }
  }

  async #shutdown(): Promise<void> {
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    for (const slot of this.#slots) {
      try {
        slot.worker.postMessage({ kind: 'shutdown' });
      } catch {
        // worker may already be gone
      }
    }
    // Give workers a moment to drain + self-exit on shutdown messages,
    // then unref so the main process can exit cleanly even if any worker
    // is still finishing up. We deliberately do NOT call worker.terminate():
    // Bun's terminate() raises SIGILL on the main process when the worker
    // has spawned subprocesses or loaded WASM (objdiff-wasm), which our
    // workers always do.
    await new Promise((r) => setTimeout(r, 50));
    for (const slot of this.#slots) {
      try {
        slot.worker.unref();
      } catch {
        // worker may already be gone
      }
    }
  }
}
