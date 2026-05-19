/**
 * MutationSearch — generic mutation search loop with pluggable objectives.
 *
 * Assembles Pool, SlotOrchestrator, Compiler, and Scorer into a concurrent
 * search that mutates source code to minimize a score. Per-slot mutation
 * engines live inside their Bun Workers, not on the main thread.
 * The default score is assembly instruction-level diff count (lower = better,
 * 0 = perfect). Provide `scoreTransform` to optimize a different objective
 * (e.g., smell score for cleanup) while still using assembly scoring as the base.
 *
 * Used by: `transmuter match` (assembly matching), `transmuter refine`
 * (per-violation sub-searches), and on the cleanup (smell minimization).
 */
import os from 'os';
import { Compiler } from '~/compiler/compiler.js';
import type { Language } from '~/language.js';
import { ensureLanguageRegistered } from '~/parser.js';
import { Pool } from '~/pipeline/pool.js';
import type { SummarizeResult } from '~/pipeline/pool.js';
import { getProfile } from '~/profiles/get-profile.js';
import { Rng } from '~/rng.js';
import { AdaptiveSelector } from '~/rules/adaptive-selector.js';
import { builtInRules } from '~/rules/built-in/index.js';
import { RuleRegistry } from '~/rules/registry.js';
import { Objdiff } from '~/scoring/objdiff.js';
import { Scorer } from '~/scoring/scorer.js';
import { pickAutoCompactTargets } from '~/search/auto-compact.js';
import { SlotOrchestrator } from '~/search/slot-orchestrator.js';
import type {
  AutoCompactPolicy,
  AvoidRegionConstraint,
  CandidateNode,
  FocusRegionConstraint,
  MutationSearchEvent,
  MutationSearchOptions,
  MutationSearchResult,
  MutationSearchState,
  MutationTarget,
  StructuredDifference,
} from '~/types.js';

const DEFAULT_STATS_INTERVAL = 100;

/** Default worker-slot count when the caller didn't supply `concurrency`. */
export function defaultConcurrency(): number {
  return Math.min(os.cpus().length, 4);
}

const DEFAULT_AUTO_COMPACT: Required<AutoCompactPolicy> = {
  staleAfterAttempts: 500,
  minStaleThreshold: 20,
  keepMinTargets: 3,
  candidateThreshold: 200,
};

export class MutationSearch {
  #opts: MutationSearchOptions;
  #language: Language;
  #registry: RuleRegistry;
  #rng: Rng;
  #pool: Pool;
  #orchestrator: SlotOrchestrator | null = null;
  #adaptiveSelector: AdaptiveSelector | null = null;
  #focusRegions: FocusRegionConstraint[] = [];
  #avoidRegions: AvoidRegionConstraint[] = [];
  #abortController: AbortController;
  #running = false;
  #paused = false;
  #startTime = 0;
  #baseScore = 0;
  #autoCompact: Required<AutoCompactPolicy> | null;

  constructor(opts: MutationSearchOptions) {
    this.#opts = opts;
    this.#language = opts.language ?? 'c';
    this.#abortController = new AbortController();

    // Chain external signal if provided
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.#abortController.abort(), { once: true });
    }

    // Initialize RNG
    const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
    this.#rng = new Rng(seed);

    // Initialize rule registry with built-in rules
    this.#registry = new RuleRegistry();
    this.#registry.registerAll(builtInRules);

    // Apply profile
    const { profile } = getProfile({ profileId: opts.profile, compilerCommand: opts.compilerCommand });
    this.#registry.applyProfile(profile);

    // Apply user weight overrides
    if (opts.ruleWeights) {
      this.#registry.setWeights(opts.ruleWeights);
    }
    if (opts.disabledRules) {
      for (const id of opts.disabledRules) {
        this.#registry.disable(id);
      }
    }

    // Initialize pool
    this.#pool = new Pool(this.#rng, opts.lateralForkBudget);

    // Resolve auto-compact policy (enabled by default)
    if (opts.autoCompact === false) {
      this.#autoCompact = null;
    } else {
      const user = opts.autoCompact ?? {};
      this.#autoCompact = {
        staleAfterAttempts: user.staleAfterAttempts ?? DEFAULT_AUTO_COMPACT.staleAfterAttempts,
        minStaleThreshold: user.minStaleThreshold ?? DEFAULT_AUTO_COMPACT.minStaleThreshold,
        keepMinTargets: Math.max(1, user.keepMinTargets ?? DEFAULT_AUTO_COMPACT.keepMinTargets),
        candidateThreshold: user.candidateThreshold ?? DEFAULT_AUTO_COMPACT.candidateThreshold,
      };
    }
  }

  #getRuleDescriptions(): Record<string, string> {
    const descs: Record<string, string> = {};
    for (const rule of this.#registry.all()) {
      descs[rule.id] = rule.description;
    }
    return descs;
  }

  /** Start the permutation job. Resolves when complete. */
  async start(): Promise<MutationSearchResult> {
    if (this.#running) {
      throw new Error('MutationSearch is already running');
    }
    this.#running = true;
    this.#startTime = Date.now();

    const emit = (event: MutationSearchEvent) => {
      try {
        this.#opts.onEvent?.(event);
      } catch {
        // Don't crash on consumer errors
      }
      if (this.#autoCompact && event.type === 'stats') {
        this.#maybeAutoCompact(event.candidateCount, emit);
      }
    };

    let compiler: Compiler | undefined;

    try {
      ensureLanguageRegistered(this.#language);

      const scorer = new Scorer(this.#opts.targetObjectPath, this.#opts.functionName, this.#opts.diffSettings);
      compiler = new Compiler({
        command: this.#opts.compilerCommand,
        cwd: this.#opts.cwd,
        functionName: this.#opts.functionName,
        language: this.#language,
        signal: this.#abortController.signal,
        sourcePrefix: this.#opts.sourcePrefix,
      });

      // Scorer init (WASM + target parse) and the genesis compile share no state.
      const [, initialCompile] = await Promise.all([scorer.init(), compiler.compile(this.#opts.source)]);
      if (!initialCompile.success) {
        const result: MutationSearchResult = {
          perfectMatch: false,
          bestScore: -1,
          bestSource: this.#opts.source,
          baseScore: -1,
          totalIterations: 0,
          elapsed: Date.now() - this.#startTime,
          reason: 'aborted',
        };
        emit({
          type: 'error',
          message: `Initial compilation failed: ${initialCompile.error}`,
        });
        emit({
          type: 'completed',
          reason: 'aborted',
          finalScore: -1,
          totalIterations: 0,
          elapsed: result.elapsed,
          bestSource: this.#opts.source,
        });
        return result;
      }

      const initialResult = await scorer.scoreWithAssembly(initialCompile.objPath);
      await Compiler.cleanup(initialCompile.objPath);

      if (initialResult === null) {
        const result: MutationSearchResult = {
          perfectMatch: false,
          bestScore: -1,
          bestSource: this.#opts.source,
          baseScore: -1,
          totalIterations: 0,
          elapsed: Date.now() - this.#startTime,
          reason: 'aborted',
        };
        emit({
          type: 'error',
          message: `Function '${this.#opts.functionName}' not found in compiled object`,
        });
        emit({
          type: 'completed',
          reason: 'aborted',
          finalScore: -1,
          totalIterations: 0,
          elapsed: result.elapsed,
          bestSource: this.#opts.source,
        });
        return result;
      }

      const rawScore = initialResult.score;
      const initialScore = this.#opts.scoreTransform
        ? this.#opts.scoreTransform(this.#opts.source, initialResult)
        : rawScore;
      this.#baseScore = initialScore;

      // Check if objective already satisfied (score 0)
      if (initialScore === 0) {
        const result: MutationSearchResult = {
          perfectMatch: true,
          bestScore: 0,
          bestSource: this.#opts.source,
          baseScore: 0,
          totalIterations: 0,
          elapsed: Date.now() - this.#startTime,
          reason: 'perfect-match',
        };
        emit({ type: 'started', baseScore: 0, targetCount: 1, ruleDescriptions: this.#getRuleDescriptions() });
        emit({ type: 'perfect-match', iteration: 0, source: this.#opts.source, candidateId: 'genesis' });
        emit({
          type: 'completed',
          reason: 'perfect-match',
          finalScore: 0,
          totalIterations: 0,
          elapsed: result.elapsed,
          bestSource: this.#opts.source,
        });
        return result;
      }

      // Initialize pool with genesis candidate
      const { candidate: genesis, target: genesisTarget } = this.#pool.init(this.#opts.source, initialScore, {
        assembly: initialResult.assembly,
        assemblyDiff: initialResult.assemblyDiff,
        breakdown: initialResult.breakdown,
      });
      emit({
        type: 'mutation-target-created',
        mutationTargetId: genesisTarget.id,
        candidateId: genesis.id,
        score: initialScore,
        origin: 'genesis',
        assembly: initialResult.assembly,
        assemblyDiff: initialResult.assemblyDiff,
        breakdown: initialResult.breakdown,
      });
      emit({ type: 'started', baseScore: initialScore, targetCount: 1, ruleDescriptions: this.#getRuleDescriptions() });

      // Build focus constraint components
      const constraints = this.#opts.focusConstraints ?? [];
      this.#focusRegions = constraints.filter((c): c is FocusRegionConstraint => c.type === 'focus-region');
      this.#avoidRegions = constraints.filter((c): c is AvoidRegionConstraint => c.type === 'avoid-region');

      const adaptiveSelector = new AdaptiveSelector(this.#opts.adaptiveSelection);
      this.#adaptiveSelector = adaptiveSelector;

      // Process hypothesis constraints
      for (const constraint of constraints) {
        if (constraint.type !== 'hypothesis') {
          continue;
        }

        const hypCompile = await compiler.compile(constraint.source);
        if (!hypCompile.success) {
          emit({ type: 'hypothesis-scored', constraintId: constraint.id, score: -1 });
          continue;
        }

        const hypResult = await scorer.scoreWithAssembly(hypCompile.objPath);
        await Compiler.cleanup(hypCompile.objPath);

        if (hypResult === null) {
          emit({ type: 'hypothesis-scored', constraintId: constraint.id, score: -1 });
          continue;
        }

        const hypRawScore = hypResult.score;
        const hypScore = this.#opts.scoreTransform
          ? this.#opts.scoreTransform(constraint.source, hypResult)
          : hypRawScore;
        // Refiner sub-searches set a `candidateFilter` that rejects sources
        // which still contain the violation. Apply it here too so a
        // hypothesis that still contains the violation can't be reported
        // as a fixed-by-hypothesis match. Treat a filter-rejected
        // hypothesis the same as a compile/score failure (score = -1) so
        // it neither injects nor declares a perfect match.
        const passesFilter = !this.#opts.candidateFilter || this.#opts.candidateFilter(constraint.source);
        if (!passesFilter) {
          emit({ type: 'hypothesis-scored', constraintId: constraint.id, score: -1 });
          continue;
        }
        const injectAsBranch = constraint.injectAsBranch ?? true;
        let mutationTargetId: string | undefined;
        if (injectAsBranch) {
          const { target } = this.#pool.inject(constraint.source, hypScore, {
            label: constraint.description,
            assembly: hypResult.assembly,
            assemblyDiff: hypResult.assemblyDiff,
            breakdown: hypResult.breakdown,
          });
          mutationTargetId = target.id;
          emit({
            type: 'mutation-target-created',
            mutationTargetId: target.id,
            candidateId: target.candidateId,
            score: hypScore,
            origin: 'external',
            // Preserve the hypothesis source on the event so SessionStore
            // records the candidate's actual source instead of falling
            // back to the original (pre-hypothesis) source.
            source: constraint.source,
            assembly: hypResult.assembly,
            assemblyDiff: hypResult.assemblyDiff,
            breakdown: hypResult.breakdown,
          });
        }

        emit({ type: 'hypothesis-scored', constraintId: constraint.id, score: hypScore, mutationTargetId });

        if (hypScore === 0) {
          const result: MutationSearchResult = {
            perfectMatch: true,
            bestScore: 0,
            bestSource: constraint.source,
            baseScore: this.#baseScore,
            totalIterations: 0,
            elapsed: Date.now() - this.#startTime,
            reason: 'perfect-match',
          };
          emit({ type: 'perfect-match', iteration: 0, source: constraint.source, candidateId: 'hypothesis' });
          emit({
            type: 'completed',
            reason: 'perfect-match',
            finalScore: 0,
            totalIterations: 0,
            elapsed: result.elapsed,
            bestSource: constraint.source,
          });
          return result;
        }
      }

      const concurrency = this.#opts.concurrency ?? defaultConcurrency();

      this.#orchestrator = new SlotOrchestrator({
        pool: this.#pool,
        adaptiveSelector,
        registry: this.#registry,
        concurrency,
        seed: this.#opts.seed ?? Math.floor(Math.random() * 0xffffffff),
        language: this.#language,
        functionName: this.#opts.functionName,
        mutationDepth: this.#opts.mutationDepth ?? 1,
        sourcePrefix: this.#opts.sourcePrefix ?? '',
        focusRegions: this.#focusRegions,
        avoidRegions: this.#avoidRegions,
        adaptiveSelectorWindowSize: this.#opts.adaptiveSelection?.windowSize ?? 500,
        compilerCommand: this.#opts.compilerCommand,
        compilerCwd: this.#opts.cwd ?? process.cwd(),
        targetObjectPath: this.#opts.targetObjectPath,
        diffSettings: this.#opts.diffSettings ?? {},
        maxCompiles: this.#opts.maxCompiles ?? Infinity,
        timeoutMs: this.#opts.timeoutMs ?? Infinity,
        statsInterval: DEFAULT_STATS_INTERVAL,
        onEvent: emit,
        signal: this.#abortController.signal,
        candidateFilter: this.#opts.candidateFilter,
        scoreTransform: this.#opts.scoreTransform,
        maxUnproductiveResults: this.#opts.maxUnproductiveResults,
      });

      await this.#orchestrator.run();

      // Determine completion reason
      const best = this.#pool.getBest();
      let reason: MutationSearchResult['reason'];
      if (best.score === 0) {
        reason = 'perfect-match';
      } else if (this.#abortController.signal.aborted) {
        reason = 'aborted';
      } else if (
        this.#opts.maxCompiles !== undefined &&
        this.#orchestrator.getCompileAttempts() >= this.#opts.maxCompiles
      ) {
        reason = 'max-compiles';
      } else if (
        this.#opts.maxUnproductiveResults !== undefined &&
        this.#orchestrator.getCompiledCount() === 0 &&
        this.#orchestrator.getIteration() >= this.#opts.maxUnproductiveResults
      ) {
        reason = 'exhausted';
      } else {
        reason = 'timeout';
      }

      const result: MutationSearchResult = {
        perfectMatch: best.score === 0,
        bestScore: best.score,
        bestSource: best.source,
        baseScore: this.#baseScore,
        totalIterations: this.#orchestrator.getIteration(),
        elapsed: Date.now() - this.#startTime,
        reason,
      };

      emit({
        type: 'completed',
        reason,
        finalScore: best.score,
        totalIterations: result.totalIterations,
        elapsed: result.elapsed,
        bestSource: best.source,
      });

      return result;
    } finally {
      this.#running = false;
      await compiler?.destroy();
    }
  }

  /** Stop the permutation job. In-flight compilations receive SIGTERM via the abort signal. */
  stop(): void {
    this.#abortController.abort();
  }

  /** Pause all slots. */
  pause(): void {
    this.#paused = true;
    this.#orchestrator?.pause();
  }

  /** Resume paused slots. */
  resume(): void {
    this.#paused = false;
    this.#orchestrator?.resume();
  }

  /**
   * Inject external code as a new candidate and mutation target.
   * Compiles and scores it first. Returns the candidate and target, or null if compilation failed.
   */
  async injectCode(
    source: string,
    options?: { label?: string },
  ): Promise<{ candidate: CandidateNode; target: MutationTarget } | null> {
    const compiler = new Compiler({
      command: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      functionName: this.#opts.functionName,
      language: this.#language,
      signal: undefined,
      sourcePrefix: this.#opts.sourcePrefix,
    });
    const compileResult = await compiler.compile(source);
    if (!compileResult.success) {
      return null;
    }

    const scorer = new Scorer(this.#opts.targetObjectPath, this.#opts.functionName, this.#opts.diffSettings);
    await scorer.init();
    const scoreResult = await scorer.scoreWithAssembly(compileResult.objPath);
    await Compiler.cleanup(compileResult.objPath);

    if (scoreResult === null) {
      return null;
    }

    // Apply scoreTransform if present (e.g. cleanup uses smell score)
    const effectiveScore = this.#opts.scoreTransform
      ? this.#opts.scoreTransform(source, scoreResult)
      : scoreResult.score;

    const { candidate, target } = this.#pool.inject(source, effectiveScore, {
      label: options?.label,
      assembly: scoreResult.assembly,
      assemblyDiff: scoreResult.assemblyDiff,
      breakdown: scoreResult.breakdown,
    });
    try {
      this.#opts.onEvent?.({
        type: 'mutation-target-created',
        mutationTargetId: target.id,
        candidateId: candidate.id,
        score: effectiveScore,
        origin: 'external',
        source,
        assembly: scoreResult.assembly,
        assemblyDiff: scoreResult.assemblyDiff,
        breakdown: scoreResult.breakdown,
      });
    } catch {
      // Don't crash on consumer errors
    }

    // If the injection achieves a perfect match (and passes candidateFilter if present),
    // signal the running orchestrator to stop. This allows the Refiner to detect
    // violation fixes from injected code rather than only from organic mutations.
    if (effectiveScore === 0) {
      const passesFilter = !this.#opts.candidateFilter || this.#opts.candidateFilter(source);
      if (passesFilter) {
        try {
          this.#opts.onEvent?.({
            type: 'perfect-match',
            iteration: this.#orchestrator?.getIteration() ?? 0,
            source,
            candidateId: candidate.id,
          });
        } catch {
          // Don't crash on consumer errors
        }
        this.#orchestrator?.signalPerfectMatch();
      }
    }

    return { candidate, target };
  }

  /**
   * Compile source and return assembly + objdiff comparison against the target.
   * Returns null if compilation fails or the function is not found.
   */
  async getAssemblyDiff(source: string): Promise<{
    assembly: string;
    targetAssembly: string;
    diff: string;
    differences: string[];
    structuredDifferences: StructuredDifference[];
    differenceCount: number;
    matchingCount: number;
  } | null> {
    const compiler = new Compiler({
      command: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      functionName: this.#opts.functionName,
      language: this.#language,
      signal: undefined,
      sourcePrefix: this.#opts.sourcePrefix,
    });
    const compileResult = await compiler.compile(source);
    if (!compileResult.success) {
      return null;
    }

    try {
      const objdiff = new Objdiff(this.#opts.diffSettings);
      const candidateObj = await objdiff.parseObjectFile(compileResult.objPath, 'base');
      const targetObj = await objdiff.parseObjectFile(this.#opts.targetObjectPath, 'target');
      const diffResult = await objdiff.runDiff(candidateObj, targetObj);

      if (!diffResult.left || !diffResult.right) {
        return null;
      }

      const assembly = await objdiff.getAssemblyFromSymbol(diffResult.left, this.#opts.functionName);
      const targetAssembly = await objdiff.getAssemblyFromSymbol(diffResult.right, this.#opts.functionName);
      const { differenceCount, matchingCount, differences, structuredDifferences } = await objdiff.getDifferences(
        diffResult.left,
        diffResult.right,
        this.#opts.functionName,
      );

      // Also produce the side-by-side diff via Scorer for backward compat
      const scorer = new Scorer(this.#opts.targetObjectPath, this.#opts.functionName, this.#opts.diffSettings);
      await scorer.init();
      const sideBySide = await scorer.assemblyDiff(compileResult.objPath);

      return {
        assembly,
        targetAssembly,
        diff: sideBySide ?? '',
        differences,
        structuredDifferences,
        differenceCount,
        matchingCount,
      };
    } finally {
      await Compiler.cleanup(compileResult.objPath);
    }
  }

  /** Set a mutation target's scheduling weight. Returns false if the target doesn't exist. */
  setBranchWeight(mutationTargetId: string, weight: number): boolean {
    if (!this.#pool.setWeight(mutationTargetId, weight)) {
      return false;
    }
    try {
      this.#opts.onEvent?.({
        type: 'mutation-target-weight-changed',
        mutationTargetId,
        weight,
      });
    } catch {
      // Don't crash on consumer errors
    }
    return true;
  }

  /** Disable a mutation target (removed from scheduling, graph preserved). Returns false if not found. */
  disableBranch(mutationTargetId: string): boolean {
    if (!this.#pool.disable(mutationTargetId)) {
      return false;
    }
    try {
      this.#opts.onEvent?.({ type: 'mutation-target-disabled', mutationTargetId });
    } catch {
      // Don't crash on consumer errors
    }
    return true;
  }

  /** Re-enable a disabled mutation target. Returns false if not found. */
  enableBranch(mutationTargetId: string): boolean {
    if (!this.#pool.enable(mutationTargetId)) {
      return false;
    }
    try {
      this.#opts.onEvent?.({ type: 'mutation-target-enabled', mutationTargetId });
    } catch {
      // Don't crash on consumer errors
    }
    return true;
  }

  /** Update rule weights at runtime. Returns unknown rule IDs (empty if all valid). */
  updateWeights(weights: Record<string, number>): string[] {
    const unknown = this.#registry.setWeights(weights);
    this.#broadcastRulesIfWorkers();
    return unknown;
  }

  /** Enable a previously disabled rule. Returns false if the rule doesn't exist. */
  enableRule(ruleId: string): boolean {
    const ok = this.#registry.enable(ruleId);
    if (ok) {
      this.#broadcastRulesIfWorkers();
    }
    return ok;
  }

  /** Disable a rule. Returns false if the rule doesn't exist. */
  disableRule(ruleId: string): boolean {
    const ok = this.#registry.disable(ruleId);
    if (ok) {
      this.#broadcastRulesIfWorkers();
    }
    return ok;
  }

  /** Fan rule changes out to running workers. No-op when no orchestrator is running. */
  #broadcastRulesIfWorkers(): void {
    this.#orchestrator?.broadcastRules();
  }

  /** Get the rule catalog: id, description, current weight, and enabled state for every registered rule. */
  getRules(): { ruleId: string; description: string; weight: number; enabled: boolean }[] {
    return this.#registry.all().map((rule) => {
      const weight = this.#registry.getWeight(rule.id);
      return { ruleId: rule.id, description: rule.description, weight, enabled: weight > 0 };
    });
  }

  /**
   * Get per-branch rule history from the adaptive selector.
   * Returns null if adaptive selection is disabled or the branch doesn't exist.
   *
   * Note: these stats come from a sliding window (last ~500 trials per rule),
   * not cumulative totals. Old trials are evicted as new ones arrive.
   */
  getBranchRuleHistory(branchId: string): { ruleId: string; trials: number; successRate: number }[] | null {
    if (!this.#adaptiveSelector) {
      return null;
    }
    const target = this.#pool.getTarget(branchId);
    if (!target) {
      return null;
    }
    return this.#adaptiveSelector.getStats(branchId);
  }

  /**
   * Summarize dead-end subtrees into lightweight supernodes.
   * Frees candidates, targets, dedup state, and adaptive selector stats.
   * The caller is responsible for also calling SessionStore.summarize() if needed.
   */
  summarize(): SummarizeResult {
    const result = this.#pool.summarize();

    // Clean up AdaptiveSelector for each removed target
    if (this.#adaptiveSelector) {
      for (const targetId of result.removedTargetIds) {
        this.#adaptiveSelector.removeTarget(targetId);
      }
    }

    // Emit event
    try {
      this.#opts.onEvent?.({
        type: 'graph-summarized',
        removedCount: result.removed,
        superNodeCount: result.superNodes.length,
      });
    } catch {
      // Don't crash on consumer errors
    }

    return result;
  }

  /**
   * Evaluate auto-compact policy: prune targets and compact dead subtrees.
   * Called from the stats event handler inside the slot loop.
   */
  #maybeAutoCompact(candidateCount: number, emit: (event: MutationSearchEvent) => void): void {
    const policy = this.#autoCompact!;
    const active = this.#pool.getActiveTargets();
    const concurrency = this.#opts.concurrency ?? defaultConcurrency();

    const { toDisable } = pickAutoCompactTargets(
      active,
      (target) => this.#pool.getCandidate(target.candidateId)?.score ?? Infinity,
      policy,
      concurrency,
      candidateCount,
    );

    if (toDisable.length === 0) {
      return;
    }

    for (const id of toDisable) {
      this.disableBranch(id);
    }

    const result = this.summarize();

    emit({
      type: 'auto-compacted',
      disabled: toDisable.length,
      removed: result.removed,
      superNodes: result.superNodes.length,
    });
  }

  /** Replace focus and avoid region constraints at runtime. */
  setFocusConstraints(focusRegions: FocusRegionConstraint[], avoidRegions: AvoidRegionConstraint[]): void {
    this.#focusRegions = focusRegions;
    this.#avoidRegions = avoidRegions;
    this.#orchestrator?.setFocusConstraints(focusRegions, avoidRegions);
  }

  /** Get the current focus and avoid region constraints. */
  getFocusConstraints(): { focusRegions: FocusRegionConstraint[]; avoidRegions: AvoidRegionConstraint[] } {
    return { focusRegions: [...this.#focusRegions], avoidRegions: [...this.#avoidRegions] };
  }

  /** Set the number of mutations chained per iteration. */
  setMutationDepth(depth: number): void {
    this.#orchestrator?.setMutationDepth(depth);
  }

  /** Get the current mutation depth. */
  getMutationDepth(): number {
    return this.#orchestrator?.getMutationDepth() ?? this.#opts.mutationDepth ?? 1;
  }

  /** Get a snapshot of the current state. */
  getState(): MutationSearchState {
    const candidates = this.#pool.getAllCandidates();
    const best = candidates.length > 0 ? this.#pool.getBest() : null;
    return {
      running: this.#running,
      paused: this.#paused,
      functionName: this.#opts.functionName,
      iteration: this.#orchestrator?.getIteration() ?? 0,
      elapsed: this.#running ? Date.now() - this.#startTime : 0,
      bestScore: best?.score ?? -1,
      bestSource: best?.source ?? this.#opts.source,
      targets: this.#pool.getAllTargets(),
      ruleWeights: this.#registry.getAllWeights(),
    };
  }
}
