/**
 * Slot orchestrator — manages concurrent mutation/compile/score slots.
 *
 * Each slot runs an independent async loop: select target -> get head source ->
 * mutate -> compile -> score -> report to pool (potentially fork).
 * Each slot gets its own MutationEngine (with a forked RNG) for deterministic isolation.
 * All slots share the same Pool and Deduplicator.
 */
import { Compiler } from '~/compiler/compiler.js';
import type { Deduplicator } from '~/pipeline/deduplicator.js';
import type { Pool } from '~/pipeline/pool.js';
import type { AdaptiveSelector } from '~/rules/adaptive-selector.js';
import type { MutationEngine } from '~/rules/engine.js';
import { PROFILE_STATS } from '~/rules/engine.js';
import type { AssemblyScoreResult, MutationSearchEvent, MutationSearchEventHandler } from '~/types.js';

/** Minimal scorer interface used by the SlotOrchestrator. */
export interface SlotScorer {
  scoreWithAssembly(candidateObjPath: string): Promise<AssemblyScoreResult | null>;
}

export interface SlotOrchestratorOptions {
  pool: Pool;
  /** Factory that creates a per-slot MutationEngine with a forked RNG for deterministic isolation. */
  engineFactory: (slotIndex: number) => MutationEngine;
  compiler: Compiler;
  scorer: SlotScorer;
  deduplicator: Deduplicator;
  functionName: string;
  concurrency: number;
  maxIterations: number;
  timeoutMs: number;
  mutationDepth: number;
  statsInterval: number;
  onEvent: MutationSearchEventHandler;
  signal: AbortSignal;
  /** Optional filter applied after dedup, before compile. Return false to reject. */
  candidateFilter?: (source: string) => boolean;
  /**
   * Optional score transform applied after assembly scoring.
   * Receives the mutation source and the full AssemblyScoreResult, returns the final
   * score used for pool reporting and fork decisions.
   * Use case: cleanup Phase 2 returns smell score when assembly matches (asmScore == 0)
   * and a high penalty when it doesn't.
   */
  scoreTransform?: (source: string, asmResult: AssemblyScoreResult) => number;
  /** Adaptive per-target rule selector for Thompson Sampling feedback. */
  adaptiveSelector: AdaptiveSelector;
  /**
   * Maximum iterations without a single compilation before stopping.
   * When a candidateFilter rejects all mutations (e.g., refine mode for asm constructs),
   * the loop spins indefinitely. This threshold detects the situation and stops early.
   * Default: undefined (no limit).
   */
  maxUnproductiveIterations?: number;
}

interface SlotStats {
  compiled: number;
  errors: number;
  deduped: number;
}

interface PhaseTimings {
  mutate: number;
  dedup: number;
  compile: number;
  score: number;
  report: number;
  other: number;
  iterations: number;
}

const PROFILE = !!process.env.TRANSMUTER_PROFILE;

function hrms(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

export class SlotOrchestrator {
  #opts: SlotOrchestratorOptions;
  #iteration = 0;
  #lastStatsIteration = 0;
  #startTime = 0;
  #paused = false;
  #perfectMatchFound = false;
  #pauseResolvers: (() => void)[] = [];
  #slotStats: SlotStats = { compiled: 0, errors: 0, deduped: 0 };
  #mutationDepth: number;
  #phaseTimings: PhaseTimings = { mutate: 0, dedup: 0, compile: 0, score: 0, report: 0, other: 0, iterations: 0 };

  constructor(opts: SlotOrchestratorOptions) {
    this.#opts = opts;
    this.#mutationDepth = opts.mutationDepth;
  }

  /** Run all slots until completion. Returns when all slots stop. */
  async run(): Promise<void> {
    this.#startTime = Date.now();
    this.#iteration = 0;

    const slots = Array.from({ length: this.#opts.concurrency }, (_, i) => this.#slotLoop(i));

    await Promise.allSettled(slots);

    if (PROFILE) {
      const elapsedMs = Date.now() - this.#startTime;
      const wallSec = elapsedMs / 1000;
      const t = this.#phaseTimings;
      const iters = t.iterations;
      const succ = this.#slotStats.compiled;
      const parseMs = PROFILE_STATS.parseNs / 1_000_000;
      const ruleApplyMs = PROFILE_STATS.ruleApplyNs / 1_000_000;
      const summed = t.mutate + t.dedup + t.compile + t.score + t.report;
      const perIterCpu = summed / Math.max(iters, 1);
      const capacityWall = elapsedMs * this.#opts.concurrency;
      const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s (${((ms / capacityWall) * 100).toFixed(1)}%)`;
      const line = [
        `\n[TRANSMUTER_PROFILE]`,
        `  wall=${wallSec.toFixed(2)}s  iterations=${iters}  successful_compiles=${succ}  concurrency=${this.#opts.concurrency}`,
        `  iter/s=${(iters / wallSec).toFixed(2)}  avg-iter-cpu=${perIterCpu.toFixed(1)}ms (sum-of-phases/iter)`,
        `  (phase% is of total-cpu-budget = wall*concurrency = ${(capacityWall / 1000).toFixed(2)}s)`,
        `  mutate=${fmt(t.mutate)}  [parse=${(parseMs / 1000).toFixed(2)}s  ruleApply=${(ruleApplyMs / 1000).toFixed(2)}s]`,
        `  dedup=${fmt(t.dedup)}`,
        `  compile=${fmt(t.compile)}`,
        `  score=${fmt(t.score)}`,
        `  report=${fmt(t.report)}`,
      ].join('\n');
      process.stderr.write(line + '\n');
    }
  }

  /** Get current iteration count. */
  getIteration(): number {
    return this.#iteration;
  }

  /** Get total number of successful compilations. */
  getCompiledCount(): number {
    return this.#slotStats.compiled;
  }

  /** Get elapsed time in ms. */
  getElapsed(): number {
    return Date.now() - this.#startTime;
  }

  /**
   * Signal that a perfect match was found externally (e.g. via code injection).
   * All slots will stop on their next iteration check.
   */
  signalPerfectMatch(): void {
    this.#perfectMatchFound = true;
    // Wake up any paused slots so they can see the stop signal
    for (const resolve of this.#pauseResolvers) {
      resolve();
    }
    this.#pauseResolvers = [];
  }

  /** Set the number of mutations chained per iteration. */
  setMutationDepth(depth: number): void {
    this.#mutationDepth = depth;
  }

  /** Get the current mutation depth. */
  getMutationDepth(): number {
    return this.#mutationDepth;
  }

  /** Pause all slots. */
  pause(): void {
    this.#paused = true;
  }

  /** Resume all slots. */
  resume(): void {
    this.#paused = false;
    for (const resolve of this.#pauseResolvers) {
      resolve();
    }
    this.#pauseResolvers = [];
  }

  async #waitIfPaused(): Promise<void> {
    if (!this.#paused) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#pauseResolvers.push(resolve);
    });
  }

  #shouldStop(): boolean {
    if (this.#perfectMatchFound) {
      return true;
    }
    if (this.#opts.signal.aborted) {
      return true;
    }
    if (this.#iteration >= this.#opts.maxIterations) {
      return true;
    }
    if (Date.now() - this.#startTime >= this.#opts.timeoutMs) {
      return true;
    }
    if (
      this.#opts.maxUnproductiveIterations !== undefined &&
      this.#iteration > 0 &&
      this.#slotStats.compiled === 0 &&
      this.#iteration >= this.#opts.maxUnproductiveIterations
    ) {
      return true;
    }
    return false;
  }

  #emit(event: MutationSearchEvent): void {
    try {
      this.#opts.onEvent(event);
    } catch {
      // Don't let consumer errors crash the orchestrator
    }
  }

  async #slotLoop(slotId: number): Promise<void> {
    const { pool, engineFactory, compiler, scorer, deduplicator } = this.#opts;
    const engine = engineFactory(slotId);
    let tightLoopCount = 0;

    while (!this.#shouldStop()) {
      await this.#waitIfPaused();
      if (this.#shouldStop()) {
        break;
      }

      // Yield to the event loop periodically when iterations skip compilation
      // (e.g., candidate filter rejections in refine mode). Without this, the
      // loop runs entirely in microtasks and starves the HTTP server.
      if (++tightLoopCount >= 64) {
        tightLoopCount = 0;
        await new Promise<void>((r) => setImmediate(r));
      }

      // 1. Select a mutation target
      const target = pool.select();
      const headCandidate = pool.getCandidate(target.candidateId);
      if (!headCandidate) {
        continue;
      }

      // 2. Apply mutation to the head candidate's source
      const tMutateStart = PROFILE ? hrms() : 0;
      const mutation = engine.mutate(
        headCandidate.source,
        this.#opts.functionName,
        target.id,
        this.#mutationDepth,
        headCandidate.breakdown,
      );
      if (PROFILE) this.#phaseTimings.mutate += hrms() - tMutateStart;
      if (!mutation) {
        continue;
      }

      // Increment iteration (shared across slots)
      this.#iteration++;
      const currentIteration = this.#iteration;

      // Periodic stats — checked here (before the dedup/filter/compile-error
      // `continue`s) so boundary-crossing events can't be silently dropped.
      // Using `>=` rather than `currentIteration % statsInterval === 0` means
      // we emit on the first iteration that crosses each boundary even if the
      // exact modulo iteration happened to be a dedup hit.
      if (currentIteration - this.#lastStatsIteration >= this.#opts.statsInterval) {
        this.#lastStatsIteration = currentIteration;
        this.#emitStats(currentIteration);
      }

      // 3. Deduplication check
      const tDedupStart = PROFILE ? hrms() : 0;
      const isDup = deduplicator.checkAndAdd(mutation.source);
      if (PROFILE) this.#phaseTimings.dedup += hrms() - tDedupStart;
      if (isDup) {
        this.#slotStats.deduped++;
        continue;
      }

      // 3b. Candidate filter (e.g., reject re-introduced violations during refinement)
      if (this.#opts.candidateFilter && !this.#opts.candidateFilter(mutation.source)) {
        continue;
      }

      // 4. Compile
      tightLoopCount = 0;
      const tCompileStart = PROFILE ? hrms() : 0;
      const compileResult = await compiler.compile(mutation.source);
      if (PROFILE) this.#phaseTimings.compile += hrms() - tCompileStart;
      if (!compileResult.success) {
        this.#slotStats.errors++;
        pool.recordFailure(target.id);
        this.#emit({
          type: 'compilation-error',
          mutationTargetId: target.id,
          ruleId: mutation.ruleIds[0] ?? 'unknown',
          error: compileResult.error,
        });
        continue;
      }

      this.#slotStats.compiled++;

      // 5. Score + extract assembly in one pass
      const tScoreStart = PROFILE ? hrms() : 0;
      const result = await scorer.scoreWithAssembly(compileResult.objPath);
      if (PROFILE) this.#phaseTimings.score += hrms() - tScoreStart;

      // Clean up the compiled object file
      await Compiler.cleanup(compileResult.objPath);

      if (result === null) {
        continue;
      }

      const { assembly, assemblyDiff, breakdown } = result;
      const score = this.#opts.scoreTransform?.(mutation.source, result) ?? result.score;

      // 6. Report to pool (may trigger a fork)
      const ruleId = mutation.ruleIds[0] ?? 'unknown';
      const tReportStart = PROFILE ? hrms() : 0;
      const { forked } = pool.report(
        {
          mutationTargetId: target.id,
          source: mutation.source,
          score,
          breakdown,
          ruleId,
          location: mutation.location,
          assembly,
          assemblyDiff,
        },
        currentIteration,
      );
      if (PROFILE) this.#phaseTimings.report += hrms() - tReportStart;

      // 7. Emit events
      this.#emit({
        type: 'scored',
        iteration: currentIteration,
        score,
        ruleId,
        mutationTargetId: target.id,
      });

      if (forked) {
        this.#emit({
          type: 'forked',
          iteration: currentIteration,
          parentCandidateId: headCandidate.id,
          candidateId: forked.candidate.id,
          mutationTargetId: forked.mutationTarget.id,
          oldScore: headCandidate.score,
          newScore: score,
          source: mutation.source,
          ruleId,
          location: mutation.location,
          assembly,
          assemblyDiff,
          breakdown,
        });

        this.#emit({
          type: 'mutation-target-created',
          mutationTargetId: forked.mutationTarget.id,
          candidateId: forked.candidate.id,
          score,
          origin: 'organic',
        });
      }

      this.#opts.adaptiveSelector.record(target.id, ruleId, !!forked);
      if (forked) {
        this.#opts.adaptiveSelector.fork(target.id, forked.mutationTarget.id);
      }

      if (PROFILE) {
        this.#phaseTimings.iterations++;
      }

      // Perfect match — signal all slots to stop
      if (score === 0) {
        this.#perfectMatchFound = true;
        this.#emit({
          type: 'perfect-match',
          iteration: currentIteration,
          source: mutation.source,
          candidateId: forked?.candidate.id ?? headCandidate.id,
        });
        return;
      }
    }
  }

  getPhaseTimings(): PhaseTimings {
    return { ...this.#phaseTimings };
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
}
