/**
 * Refiner — improves code quality while preserving assembly output.
 *
 * Two-phase approach:
 * 1. Parallel exploration: attempt to fix each violation independently
 * 2. Sequential merge: combine fixes into a single source
 */
import os from 'os';
import { Compiler } from '~/compiler/compiler.js';
import { builtInGuidelines } from '~/guidelines/built-in/index.js';
import type { Guideline, Violation } from '~/guidelines/guideline.js';
import { GuidelineRegistry } from '~/guidelines/registry.js';
import { ensureLanguageRegistered } from '~/parser.js';
import { Rng } from '~/rng.js';
import { Scorer } from '~/scoring/scorer.js';
import { MutationSearch } from '~/search/mutation-search.js';
import { SessionStore } from '~/session/store.js';
import type {
  AvoidRegionConstraint,
  CandidateNode,
  FocusConstraint,
  FocusRegionConstraint,
  MutationSearchEvent,
  MutationSearchState,
  MutationTarget,
  RefinementConfig,
  RefinementResult,
  RefinerEvent,
  RefinerOptions,
  RuleStatsEntry,
  SessionConfig,
  SessionReport,
  StructuredDifference,
  ViolationReport,
} from '~/types.js';

import { RefinementStore, mergeRuleStats } from './refiner-store.js';

interface ExplorationResult {
  violationId: string;
  status: 'fixed' | 'trivially-fixed' | 'removal-failed' | 'transmuter-exhausted';
  fixedSource?: string;
  iterations: number;
  elapsed: number;
  bestScore: number;
  scoreAfterRemoval: number;
  /** Full sub-session report from the internal MutationSearch run */
  subSession?: SessionReport;
  /** Side-by-side assembly diff between best candidate and target */
  assemblyDiff?: string;
}

export interface ActiveSubSession {
  search: MutationSearch;
  store: SessionStore;
  violationId: string;
}

export class Refiner {
  #opts: RefinerOptions;
  #registry: GuidelineRegistry;
  #store: RefinementStore;
  #abortController: AbortController;

  /**
   * Active MutationSearch sub-sessions, keyed by violation ID.
   * During Phase 1 multiple may run concurrently; during Phase 2 one at a time.
   * Empty between phases and after completion.
   */
  #activeSubSessions = new Map<string, ActiveSubSession>();

  constructor(opts: RefinerOptions) {
    this.#opts = opts;
    this.#abortController = new AbortController();

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.#abortController.abort(), { once: true });
    }

    this.#registry = new GuidelineRegistry();
    this.#registry.registerAll(builtInGuidelines);

    this.#store = new RefinementStore({
      label: `${opts.functionName} — refine (${opts.guidelineId})`,
    });
  }

  /** Get the report store (for external access to the report). */
  getStore(): RefinementStore {
    return this.#store;
  }

  /** Get the currently active sub-sessions (may be empty between phases). */
  getActiveSubSessions(): ReadonlyMap<string, ActiveSubSession> {
    return this.#activeSubSessions;
  }

  /** Detect guideline violations in arbitrary source code. */
  detectViolations(
    source: string,
  ): { id: string; description: string; lines: { start: number; end: number }; text: string }[] {
    const guideline = this.#registry.get(this.#opts.guidelineId);
    if (!guideline) {
      return [];
    }
    return guideline.detect(source, this.#opts.functionName);
  }

  // ---------------------------------------------------------------------------
  // Forwarding methods — delegate to all active MutationSearch sub-sessions.
  // These give the HTTP API the same control surface as a match session.
  // ---------------------------------------------------------------------------

  /** Pause all active sub-sessions. */
  pause(): void {
    for (const { search } of this.#activeSubSessions.values()) {
      search.pause();
    }
  }

  /** Resume all active sub-sessions. */
  resume(): void {
    for (const { search } of this.#activeSubSessions.values()) {
      search.resume();
    }
  }

  /**
   * Inject code into a specific sub-session (by violationId) or the first active one.
   * Returns null if no sub-session is active or compilation fails.
   *
   * If the injection achieves a perfect match (score 0) AND the specific
   * violation is no longer detected in the injected source, the violation
   * is marked as fixed and the sub-session is stopped.
   */
  async injectCode(
    source: string,
    options?: { label?: string; violationId?: string },
  ): Promise<{ candidate: CandidateNode; target: MutationTarget } | null> {
    const sub = options?.violationId
      ? this.#activeSubSessions.get(options.violationId)
      : this.#activeSubSessions.values().next().value;
    if (!sub) {
      return null;
    }

    const result = await sub.search.injectCode(source, options);
    if (!result) {
      return null;
    }

    // Check if this injection fixes the violation:
    // 1. Must be a perfect assembly match (score 0)
    // 2. The specific violation must no longer be detected in the source
    if (result.candidate.score === 0) {
      const guideline = this.#registry.get(this.#opts.guidelineId);
      if (guideline) {
        const detected = guideline.detect(source, this.#opts.functionName);
        const violationStillPresent = detected.some((v) => v.id === sub.violationId);
        if (!violationStillPresent) {
          // Emit the violation-fixed event
          const event: RefinerEvent = {
            type: 'violation-fixed',
            violationId: sub.violationId,
            iterations: sub.search.getState().iteration,
            elapsed: sub.search.getState().elapsed,
          };
          try {
            this.#opts.onEvent?.(event);
          } catch {
            // Don't crash on consumer errors
          }
          this.#store.push(event);

          // Stop the sub-session so it doesn't keep running
          sub.search.stop();
        }
      }
    }

    return result;
  }

  /** Get assembly diff using the first active sub-session's compiler config. */
  async getAssemblyDiff(source: string): Promise<{
    assembly: string;
    targetAssembly: string;
    diff: string;
    differences: string[];
    structuredDifferences: StructuredDifference[];
    differenceCount: number;
    matchingCount: number;
  } | null> {
    const sub = this.#activeSubSessions.values().next().value as ActiveSubSession | undefined;
    if (!sub) {
      return null;
    }
    return sub.search.getAssemblyDiff(source);
  }

  /** Set branch weight. Returns false if the target doesn't exist in any active sub-session. */
  setBranchWeight(mutationTargetId: string, weight: number): boolean {
    let found = false;
    for (const { search } of this.#activeSubSessions.values()) {
      if (search.setBranchWeight(mutationTargetId, weight)) {
        found = true;
      }
    }
    return found;
  }

  /** Disable a branch. Returns false if not found in any active sub-session. */
  disableBranch(mutationTargetId: string): boolean {
    let found = false;
    for (const { search } of this.#activeSubSessions.values()) {
      if (search.disableBranch(mutationTargetId)) {
        found = true;
      }
    }
    return found;
  }

  /** Enable a branch. Returns false if not found in any active sub-session. */
  enableBranch(mutationTargetId: string): boolean {
    let found = false;
    for (const { search } of this.#activeSubSessions.values()) {
      if (search.enableBranch(mutationTargetId)) {
        found = true;
      }
    }
    return found;
  }

  /** Update rule weights across all active sub-sessions. Returns unknown rule IDs. */
  updateWeights(weights: Record<string, number>): string[] {
    let unknown: string[] = [];
    for (const { search } of this.#activeSubSessions.values()) {
      unknown = search.updateWeights(weights);
    }
    return unknown;
  }

  /** Enable a rule across all active sub-sessions. Returns false if the rule doesn't exist. */
  enableRule(ruleId: string): boolean {
    let found = false;
    for (const { search } of this.#activeSubSessions.values()) {
      if (search.enableRule(ruleId)) {
        found = true;
      }
    }
    return found;
  }

  /** Disable a rule across all active sub-sessions. Returns false if the rule doesn't exist. */
  disableRule(ruleId: string): boolean {
    let found = false;
    for (const { search } of this.#activeSubSessions.values()) {
      if (search.disableRule(ruleId)) {
        found = true;
      }
    }
    return found;
  }

  /** Replace focus and avoid region constraints across all active sub-sessions. */
  setFocusConstraints(focusRegions: FocusRegionConstraint[], avoidRegions: AvoidRegionConstraint[]): void {
    for (const { search } of this.#activeSubSessions.values()) {
      search.setFocusConstraints(focusRegions, avoidRegions);
    }
  }

  /** Get focus constraints from the first active sub-session. */
  getFocusConstraints(): { focusRegions: FocusRegionConstraint[]; avoidRegions: AvoidRegionConstraint[] } {
    const sub = this.#activeSubSessions.values().next().value as ActiveSubSession | undefined;
    return sub?.search.getFocusConstraints() ?? { focusRegions: [], avoidRegions: [] };
  }

  /** Set mutation depth across all active sub-sessions. */
  setMutationDepth(depth: number): void {
    for (const { search } of this.#activeSubSessions.values()) {
      search.setMutationDepth(depth);
    }
  }

  /** Get mutation depth from the first active sub-session. */
  getMutationDepth(): number {
    const sub = this.#activeSubSessions.values().next().value as ActiveSubSession | undefined;
    return sub?.search.getMutationDepth() ?? 1;
  }

  /** Get rule catalog from the first active sub-session. */
  getRules(): { ruleId: string; description: string; weight: number; enabled: boolean }[] {
    const sub = this.#activeSubSessions.values().next().value as ActiveSubSession | undefined;
    return sub?.search.getRules() ?? [];
  }

  /** Get per-branch rule history from the first active sub-session, or null. */
  getBranchRuleHistory(branchId: string): { ruleId: string; trials: number; successRate: number }[] | null {
    const sub = this.#activeSubSessions.values().next().value as ActiveSubSession | undefined;
    return sub?.search.getBranchRuleHistory(branchId) ?? null;
  }

  /**
   * Aggregated rule stats across:
   *   - every completed sub-session in the refinement store, AND
   *   - every currently-running sub-session's live `SessionStore`.
   *
   * The two sources are disjoint at any moment (the refinement store only
   * receives a sub-session report after its `MutationSearch.start()` resolves,
   * at which point it's no longer in `#activeSubSessions`), so summing them is
   * safe and matches the per-session aggregation that `RuleStatsEntry`
   * fields use.
   *
   * This is the source for `GET /rules/history` in refine mode — it stays
   * populated during Phase 1 (when the refinement store is still empty)
   * by reading the live sub-session(s).
   */
  getRuleStats(): RuleStatsEntry[] {
    const completed = this.#store.getRuleStats();
    const live: RuleStatsEntry[][] = [];
    for (const { store } of this.#activeSubSessions.values()) {
      live.push(store.getRuleStats());
    }
    return mergeRuleStats([completed, ...live]);
  }

  /** Summarize dead-end subtrees across all active sub-sessions. */
  summarize(): { removed: number; superNodes: unknown[]; removedTargetIds: string[] } {
    let totalRemoved = 0;
    const allSuperNodes: unknown[] = [];
    const allRemovedTargetIds: string[] = [];
    for (const { search } of this.#activeSubSessions.values()) {
      const result = search.summarize();
      totalRemoved += result.removed;
      allSuperNodes.push(...result.superNodes);
      allRemovedTargetIds.push(...result.removedTargetIds);
    }
    return { removed: totalRemoved, superNodes: allSuperNodes, removedTargetIds: allRemovedTargetIds };
  }

  /** Aggregate state across all active sub-sessions. */
  getState(): MutationSearchState {
    const sessions = [...this.#activeSubSessions.values()];
    if (sessions.length === 0) {
      return {
        running: false,
        paused: false,
        functionName: this.#opts.functionName,
        iteration: 0,
        elapsed: 0,
        bestScore: -1,
        bestSource: this.#opts.source,
        targets: [],
        ruleWeights: {},
      };
    }
    if (sessions.length === 1) {
      return sessions[0]!.search.getState();
    }
    // Multiple active sub-sessions: aggregate
    const states = sessions.map((s) => s.search.getState());
    const first = states[0]!;
    return {
      running: states.some((s) => s.running),
      paused: states.every((s) => s.paused),
      functionName: this.#opts.functionName,
      iteration: states.reduce((sum, s) => sum + s.iteration, 0),
      elapsed: Math.max(...states.map((s) => s.elapsed)),
      bestScore: Math.min(...states.map((s) => s.bestScore).filter((s) => s >= 0)),
      bestSource: states.reduce((best, s) => (s.bestScore < best.bestScore ? s : best), first).bestSource,
      targets: states.flatMap((s) => s.targets),
      ruleWeights: first.ruleWeights,
    };
  }

  /** Run the refinement. */
  async refine(): Promise<RefinementResult> {
    const language = this.#opts.language ?? 'c';
    ensureLanguageRegistered(language);

    const startTime = Date.now();
    const emit = (event: RefinerEvent) => {
      try {
        this.#opts.onEvent?.(event);
      } catch {
        // Don't crash on consumer errors
      }
      this.#store.push(event);
    };

    // Resolve guideline
    const guideline = this.#registry.get(this.#opts.guidelineId);
    if (!guideline) {
      const available = this.#registry
        .list()
        .map((g) => g.id)
        .join(', ');
      throw new Error(`Unknown guideline: '${this.#opts.guidelineId}'. Available: ${available}`);
    }

    this.#store.setGuidelineDescription(guideline.description);
    this.#store.setOriginalSource(this.#opts.source);

    const seed = this.#opts.seed ?? Math.floor(Math.random() * 0xffffffff);
    const concurrency = this.#opts.concurrency ?? Math.min(os.cpus().length, 4);
    const maxCompilesPerViolation = this.#opts.maxCompilesPerViolation ?? Infinity;
    const timeoutPerViolation = this.#opts.timeoutMsPerViolation ?? Infinity;

    const config: RefinementConfig = {
      functionName: this.#opts.functionName,
      targetObjectPath: this.#opts.targetObjectPath,
      compilerCommand: this.#opts.compilerCommand,
      language: this.#opts.language ?? 'c',
      profile: this.#opts.profile,
      guidelineId: this.#opts.guidelineId,
      concurrency,
      maxCompilesPerViolation,
      timeoutMsPerViolation: timeoutPerViolation,
      seed,
    };
    this.#store.setConfig(config);

    // 1. Sanity check — verify the source already matches
    const scorer = new Scorer(this.#opts.targetObjectPath, this.#opts.functionName, this.#opts.diffSettings);
    await scorer.init();

    const compiler = new Compiler({
      command: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      functionName: this.#opts.functionName,
      language: this.#opts.language,
      signal: this.#abortController.signal,
      sourcePrefix: this.#opts.sourcePrefix,
    });

    try {
      const initialCompile = await compiler.compile(this.#opts.source);
      if (!initialCompile.success) {
        emit({ type: 'sanity-check-failed', score: -1, error: `Compilation failed: ${initialCompile.error}` });
        throw new Error(`Sanity check failed: source does not compile: ${initialCompile.error}`);
      }

      const initialScore = await scorer.score(initialCompile.objPath);
      await Compiler.cleanup(initialCompile.objPath);

      if (initialScore === null) {
        emit({ type: 'sanity-check-failed', score: -1, error: `Function '${this.#opts.functionName}' not found` });
        throw new Error(`Sanity check failed: function '${this.#opts.functionName}' not found in compiled object`);
      }

      if (initialScore !== 0) {
        emit({
          type: 'sanity-check-failed',
          score: initialScore,
          error: `Score is ${initialScore}, not 0. Refinement requires a matching function.`,
        });
        throw new Error(
          `Sanity check failed: source scores ${initialScore}, not 0. Refinement only operates on matching code.`,
        );
      }

      emit({ type: 'sanity-check-passed', score: 0 });

      // 2. Detect violations
      const violations = guideline.detect(this.#opts.source, this.#opts.functionName);

      const violationReports: ViolationReport[] = violations.map((v) => ({
        id: v.id,
        lines: v.lines,
        description: v.description,
        originalText: v.text,
        status: 'pending' as const,
      }));
      this.#store.setViolations(violationReports);

      emit({
        type: 'violations-detected',
        count: violations.length,
        violations: violations.map((v) => ({ id: v.id, description: v.description })),
      });

      if (violations.length === 0) {
        const result: RefinementResult = {
          source: this.#opts.source,
          violationsFixed: 0,
          violationsTotal: 0,
          trivialFixes: 0,
          permutedFixes: 0,
          resolvedByPrior: 0,
          notFixable: 0,
          elapsed: Date.now() - startTime,
        };
        emit({ type: 'completed', result });
        return result;
      }

      // 3. Phase 1 — Parallel exploration
      const explorationResults = await this.#phase1Explore(
        violations,
        guideline,
        seed,
        concurrency,
        maxCompilesPerViolation,
        timeoutPerViolation,
        emit,
      );

      // Update store with Phase 1 results
      for (const er of explorationResults) {
        if (er.fixedSource) {
          this.#store.updateViolationFix(er.violationId, er.fixedSource);
        }
        const vr = violationReports.find((v) => v.id === er.violationId);
        if (vr) {
          vr.exploration = {
            iterations: er.iterations,
            elapsed: er.elapsed,
            finalScore: er.bestScore,
            scoreAfterRemoval: er.scoreAfterRemoval,
            subSession: er.subSession,
            assemblyDiff: er.assemblyDiff,
          };
        }
        if (er.subSession) {
          this.#store.setSubSession(er.violationId, er.subSession);
        }
      }

      // 4. Phase 2 — Sequential merge
      let finalSource = this.#opts.source;
      let trivialFixes = 0;
      let permutedFixes = 0;
      let resolvedByPrior = 0;
      let notFixable = 0;

      if (this.#opts.skipMerge) {
        // Count Phase 1 results only
        for (const er of explorationResults) {
          if (er.status === 'trivially-fixed') {
            trivialFixes++;
          } else if (er.status === 'fixed') {
            permutedFixes++;
          } else {
            notFixable++;
          }
        }
        // Use the best single-violation fix if any
        const bestFix = explorationResults.find((er) => er.status === 'trivially-fixed' || er.status === 'fixed');
        if (bestFix?.fixedSource) {
          finalSource = bestFix.fixedSource;
        }
      } else if (violations.length <= 1) {
        // Single violation — no merge needed, use Phase 1 result directly
        for (const er of explorationResults) {
          if (er.status === 'trivially-fixed') {
            trivialFixes++;
            if (er.fixedSource) {
              finalSource = er.fixedSource;
            }
          } else if (er.status === 'fixed') {
            permutedFixes++;
            if (er.fixedSource) {
              finalSource = er.fixedSource;
            }
          } else {
            notFixable++;
          }
        }
      } else {
        emit({ type: 'merge-started' });

        const mergeResult = await this.#phase2Merge(
          violations,
          explorationResults,
          guideline,
          seed,
          concurrency,
          maxCompilesPerViolation,
          timeoutPerViolation,
          emit,
        );
        finalSource = mergeResult.source;
        trivialFixes = mergeResult.trivialFixes;
        permutedFixes = mergeResult.permutedFixes;
        resolvedByPrior = mergeResult.resolvedByPrior;
        notFixable = mergeResult.notFixable;
      }

      const result: RefinementResult = {
        source: finalSource,
        violationsFixed: trivialFixes + permutedFixes + resolvedByPrior,
        violationsTotal: violations.length,
        trivialFixes,
        permutedFixes,
        resolvedByPrior,
        notFixable,
        elapsed: Date.now() - startTime,
      };
      emit({ type: 'completed', result });
      return result;
    } finally {
      await compiler.destroy();
    }
  }

  /** Stop the refinement. */
  stop(): void {
    this.#abortController.abort();
  }

  // -------------------------------------------------------------------------
  // Phase 1 — Parallel exploration
  // -------------------------------------------------------------------------

  async #phase1Explore(
    violations: Violation[],
    guideline: Guideline,
    seed: number,
    concurrency: number,
    maxCompilesPerViolation: number,
    timeoutPerViolation: number,
    emit: (event: RefinerEvent) => void,
  ): Promise<ExplorationResult[]> {
    // Split concurrency across violations
    const slotsPerViolation = Math.max(1, Math.floor(concurrency / violations.length));

    const promises = violations.map(async (violation, i) => {
      if (this.#abortController.signal.aborted) {
        return {
          violationId: violation.id,
          status: 'removal-failed' as const,
          iterations: 0,
          elapsed: 0,
          bestScore: -1,
          scoreAfterRemoval: -1,
        };
      }

      emit({ type: 'violation-fix-started', violationId: violation.id });

      return this.#tryFixViolation(
        violation,
        guideline,
        seed + i + 1,
        slotsPerViolation,
        maxCompilesPerViolation,
        timeoutPerViolation,
        emit,
      );
    });

    return Promise.all(promises);
  }

  async #tryFixViolation(
    violation: Violation,
    guideline: Guideline,
    seed: number,
    concurrency: number,
    maxCompiles: number,
    timeoutMs: number,
    emit: (event: RefinerEvent) => void,
  ): Promise<ExplorationResult> {
    const startTime = Date.now();

    // Remove the violation
    const cleanedSource = guideline.remove(this.#opts.source, violation);
    if (cleanedSource === null) {
      emit({
        type: 'violation-removal-failed',
        violationId: violation.id,
        reason: 'Guideline could not produce a clean removal',
      });
      return {
        violationId: violation.id,
        status: 'removal-failed',
        iterations: 0,
        elapsed: 0,
        bestScore: -1,
        scoreAfterRemoval: -1,
      };
    }

    // Score the cleaned source
    const scorer = new Scorer(this.#opts.targetObjectPath, this.#opts.functionName, this.#opts.diffSettings);
    await scorer.init();

    const compiler = new Compiler({
      command: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      functionName: this.#opts.functionName,
      language: this.#opts.language,
      signal: this.#abortController.signal,
      sourcePrefix: this.#opts.sourcePrefix,
    });

    try {
      const compileResult = await compiler.compile(cleanedSource);
      if (!compileResult.success) {
        emit({
          type: 'violation-removal-failed',
          violationId: violation.id,
          reason: `Cleaned source does not compile: ${compileResult.error}`,
        });
        return {
          violationId: violation.id,
          status: 'removal-failed',
          iterations: 0,
          elapsed: Date.now() - startTime,
          bestScore: -1,
          scoreAfterRemoval: -1,
        };
      }

      const scoreAfterRemoval = await scorer.score(compileResult.objPath);
      await Compiler.cleanup(compileResult.objPath);

      if (scoreAfterRemoval === null) {
        emit({
          type: 'violation-removal-failed',
          violationId: violation.id,
          reason: `Function '${this.#opts.functionName}' not found after removal`,
        });
        return {
          violationId: violation.id,
          status: 'removal-failed',
          iterations: 0,
          elapsed: Date.now() - startTime,
          bestScore: -1,
          scoreAfterRemoval: -1,
        };
      }

      // Trivial fix — removal alone gives score 0
      if (scoreAfterRemoval === 0) {
        emit({ type: 'violation-trivially-fixed', violationId: violation.id, fixedSource: cleanedSource });
        return {
          violationId: violation.id,
          status: 'trivially-fixed',
          fixedSource: cleanedSource,
          iterations: 0,
          elapsed: Date.now() - startTime,
          bestScore: 0,
          scoreAfterRemoval: 0,
        };
      }

      // Need permutation — run MutationSearch to find a new match
      const candidateFilter = this.#buildCandidateFilter(guideline, violation);

      // Build focus constraints: built-in focus region + user-provided constraints
      const focusConstraints: FocusConstraint[] = [
        {
          type: 'focus-region',
          id: `fix-${violation.id}`,
          description: `Focus mutations near violation ${violation.id}`,
          lines: {
            start: Math.max(1, violation.lines.start - 5),
            end: violation.lines.end + 5,
          },
          strength: 0.5,
        },
        ...(this.#opts.focusConstraints ?? []),
      ];

      // Check for user-provided hypothesis for this violation
      const hypotheses = this.#opts.violationHypotheses?.filter((h) => h.violationId === violation.id) ?? [];
      for (const h of hypotheses) {
        focusConstraints.push({
          type: 'hypothesis',
          id: `hyp-${violation.id}-${focusConstraints.length}`,
          description: h.description ?? `User hypothesis for ${violation.id}`,
          source: h.source,
          injectAsBranch: true,
        });
      }

      // Create a SessionStore to capture the sub-session report
      const subStore = new SessionStore({
        metadata: {
          sessionId: `refine-${violation.id}`,
          label: `Refine ${violation.id}`,
        },
        focusConstraints,
      });
      subStore.setOriginalSource(cleanedSource);

      const search = new MutationSearch({
        source: cleanedSource,
        language: this.#opts.language,
        functionName: this.#opts.functionName,
        targetObjectPath: this.#opts.targetObjectPath,
        compilerCommand: this.#opts.compilerCommand,
        cwd: this.#opts.cwd,
        sourcePrefix: this.#opts.sourcePrefix,
        profile: this.#opts.profile,
        concurrency,
        maxCompiles,
        timeoutMs,
        seed,
        // Lateral forks let the permuter explore code plateaus where intermediate
        // transformations don't improve the score but lead to eventual improvements.
        // This is critical for refinement where multi-step rewrites are needed.
        lateralForkBudget: 10,
        disabledRules: guideline.disabledRules,
        diffSettings: this.#opts.diffSettings,
        signal: this.#abortController.signal,
        candidateFilter,
        maxUnproductiveResults: 100_000,
        focusConstraints,
        onEvent(event: MutationSearchEvent) {
          subStore.push(event);
          if (event.type === 'stats' || event.type === 'forked') {
            emit({
              type: 'violation-fix-progress',
              violationId: violation.id,
              iteration: event.type === 'stats' ? event.iteration : event.iteration,
              score: event.type === 'stats' ? event.bestScore : event.newScore,
            });
          }
          if (event.type === 'perfect-match') {
            emit({
              type: 'violation-fix-progress',
              violationId: violation.id,
              iteration: event.iteration,
              score: 0,
            });
          }
          if (event.type === 'hypothesis-scored') {
            const constraint = focusConstraints.find((c) => c.id === event.constraintId);
            emit({
              type: 'violation-hypothesis-scored',
              violationId: violation.id,
              hypothesisId: event.constraintId,
              description: constraint?.description ?? event.constraintId,
              score: event.score,
            });
          }
        },
      });

      // Set config on the sub-store after MutationSearch is configured
      subStore.setConfig({
        functionName: this.#opts.functionName,
        targetObjectPath: this.#opts.targetObjectPath,
        compilerCommand: this.#opts.compilerCommand,
        language: this.#opts.language ?? 'c',
        profile: this.#opts.profile,
        concurrency,
        maxCompiles,
        timeoutMs,
        seed,
        mutationDepth: 1,
        lateralForkBudget: 10,
        ruleWeights: {},
        disabledRules: guideline.disabledRules,
        focusConstraints,
      } satisfies SessionConfig);

      this.#activeSubSessions.set(violation.id, { search, store: subStore, violationId: violation.id });
      const result = await search.start();
      this.#activeSubSessions.delete(violation.id);
      const elapsed = Date.now() - startTime;
      const subSession = subStore.toJSON();

      if (result.perfectMatch) {
        emit({ type: 'violation-fixed', violationId: violation.id, iterations: result.totalIterations, elapsed });
        return {
          violationId: violation.id,
          status: 'fixed',
          fixedSource: result.bestSource,
          iterations: result.totalIterations,
          elapsed,
          bestScore: 0,
          scoreAfterRemoval,
          subSession,
        };
      }

      // Compile best candidate and get assembly diff for the report
      let assemblyDiff: string | undefined;
      const bestCompile = await compiler.compile(result.bestSource);
      if (bestCompile.success) {
        assemblyDiff = (await scorer.assemblyDiff(bestCompile.objPath)) ?? undefined;
        await Compiler.cleanup(bestCompile.objPath);
      }

      emit({
        type: 'violation-transmuter-exhausted',
        violationId: violation.id,
        bestScore: result.bestScore,
        iterations: result.totalIterations,
      });
      return {
        violationId: violation.id,
        status: 'transmuter-exhausted',
        iterations: result.totalIterations,
        elapsed,
        bestScore: result.bestScore,
        scoreAfterRemoval,
        subSession,
        assemblyDiff,
      };
    } finally {
      await compiler.destroy();
    }
  }

  #buildCandidateFilter(guideline: Guideline, violation: Violation): (source: string) => boolean {
    if (guideline.containsViolation) {
      const check = guideline.containsViolation.bind(guideline);
      return (source: string) => !check(source, violation);
    }
    // Fallback: use detect() and check if this specific violation reappears
    return (source: string) => {
      const detected = guideline.detect(source, this.#opts.functionName);
      return !detected.some((v) => v.id === violation.id);
    };
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Sequential merge
  // -------------------------------------------------------------------------

  async #phase2Merge(
    violations: Violation[],
    explorationResults: ExplorationResult[],
    guideline: Guideline,
    seed: number,
    concurrency: number,
    maxCompilesPerViolation: number,
    timeoutPerViolation: number,
    emit: (event: RefinerEvent) => void,
  ): Promise<{
    source: string;
    trivialFixes: number;
    permutedFixes: number;
    resolvedByPrior: number;
    notFixable: number;
  }> {
    // Sort by fixability: trivially-fixed first, then fixed, then exhausted/failed last
    const order = ['trivially-fixed', 'fixed', 'transmuter-exhausted', 'removal-failed'] as const;
    const sorted = [...explorationResults].sort((a, b) => {
      const aIdx = order.indexOf(a.status);
      const bIdx = order.indexOf(b.status);
      if (aIdx !== bIdx) {
        return aIdx - bIdx;
      }
      // Within same status, prefer fewer iterations (less disruptive)
      return a.iterations - b.iterations;
    });

    let currentBase = this.#opts.source;
    let trivialFixes = 0;
    let permutedFixes = 0;
    let resolvedByPrior = 0;
    let notFixable = 0;
    let step = 0;

    for (const er of sorted) {
      if (this.#abortController.signal.aborted) {
        notFixable++;
        continue;
      }

      step++;
      const violation = violations.find((v) => v.id === er.violationId)!;

      // Re-detect: does this violation still exist in the current base?
      const stillPresent = guideline.detect(currentBase, this.#opts.functionName).some((v) => v.id === violation.id);

      if (!stillPresent) {
        // Prior fix incidentally resolved this violation
        resolvedByPrior++;
        emit({ type: 'merge-step', step, violationId: violation.id, action: 'skipped-already-resolved' });

        if (this.#store.hasViolation(violation.id)) {
          // Update status in store — resolved by a prior fix, so currentBase is the fixed source
          this.#store.push({
            type: 'violation-trivially-fixed',
            violationId: violation.id,
            fixedSource: currentBase,
          });
        }
        continue;
      }

      if (er.status === 'removal-failed' || er.status === 'transmuter-exhausted') {
        notFixable++;
        emit({ type: 'merge-step', step, violationId: violation.id, action: 'failed' });
        continue;
      }

      // Try trivial removal from current base
      const cleanedBase = guideline.remove(currentBase, violation);
      if (!cleanedBase) {
        notFixable++;
        emit({ type: 'merge-step', step, violationId: violation.id, action: 'failed' });
        continue;
      }

      // Score the trivial removal
      const trivialScore = await this.#compileAndScore(cleanedBase);

      if (trivialScore === 0) {
        // Trivial fix works from current base
        const previousBase = currentBase;
        currentBase = cleanedBase;
        trivialFixes++;
        emit({ type: 'merge-step', step, violationId: violation.id, action: 'applied-trivially' });
        this.#store.updateMergeStep(step, currentBase, previousBase);
        continue;
      }

      // Need to re-permute from current base with this violation removed
      const candidateFilter = this.#buildCandidateFilter(guideline, violation);
      const rng = new Rng(seed + step);

      // Build focus constraints for merge phase
      const mergeFocusConstraints: FocusConstraint[] = [...(this.#opts.focusConstraints ?? [])];

      // Inject Phase 1 result as hypothesis if available
      if (er.fixedSource) {
        mergeFocusConstraints.push({
          type: 'hypothesis',
          id: `phase1-${violation.id}`,
          description: `Phase 1 fix for ${violation.id}`,
          source: er.fixedSource,
          injectAsBranch: true,
        });
      }

      const mergeSubStore = new SessionStore({
        metadata: {
          sessionId: `merge-${violation.id}`,
          label: `Merge ${violation.id}`,
        },
        focusConstraints: mergeFocusConstraints,
      });
      mergeSubStore.setOriginalSource(cleanedBase);

      const search = new MutationSearch({
        source: cleanedBase,
        language: this.#opts.language,
        functionName: this.#opts.functionName,
        targetObjectPath: this.#opts.targetObjectPath,
        compilerCommand: this.#opts.compilerCommand,
        cwd: this.#opts.cwd,
        sourcePrefix: this.#opts.sourcePrefix,
        profile: this.#opts.profile,
        concurrency,
        maxCompiles: maxCompilesPerViolation,
        timeoutMs: timeoutPerViolation,
        seed: rng.int(0, 0xffffffff),
        // Same exploration knobs as Phase 1 — see the Phase 1 sub-search for
        // rationale. Without `lateralForkBudget`, multi-step rewrites stall
        // on score plateaus; without `maxUnproductiveResults` the merge can
        // burn the full `maxCompiles` even when `candidateFilter` rejects
        // every mutation.
        lateralForkBudget: 10,
        maxUnproductiveResults: 100_000,
        disabledRules: guideline.disabledRules,
        diffSettings: this.#opts.diffSettings,
        signal: this.#abortController.signal,
        candidateFilter,
        focusConstraints: mergeFocusConstraints,
        onEvent(event: MutationSearchEvent) {
          mergeSubStore.push(event);
        },
      });

      this.#activeSubSessions.set(violation.id, { search, store: mergeSubStore, violationId: violation.id });
      const result = await search.start();
      this.#activeSubSessions.delete(violation.id);

      if (result.perfectMatch) {
        const previousBase = currentBase;
        currentBase = result.bestSource;
        permutedFixes++;
        emit({ type: 'merge-step', step, violationId: violation.id, action: 'permuted' });
        this.#store.updateMergeStep(step, currentBase, previousBase);
      } else {
        notFixable++;
        emit({ type: 'merge-step', step, violationId: violation.id, action: 'failed' });
      }
    }

    return { source: currentBase, trivialFixes, permutedFixes, resolvedByPrior, notFixable };
  }

  async #compileAndScore(source: string): Promise<number | null> {
    const compiler = new Compiler({
      command: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      functionName: this.#opts.functionName,
      language: this.#opts.language,
      signal: this.#abortController.signal,
      sourcePrefix: this.#opts.sourcePrefix,
    });

    try {
      const result = await compiler.compile(source);
      if (!result.success) {
        return null;
      }

      const scorer = new Scorer(this.#opts.targetObjectPath, this.#opts.functionName, this.#opts.diffSettings);
      await scorer.init();
      const score = await scorer.score(result.objPath);
      await Compiler.cleanup(result.objPath);
      return score;
    } finally {
      await compiler.destroy();
    }
  }
}
