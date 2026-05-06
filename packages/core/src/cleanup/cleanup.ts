/**
 * Cleanup pipeline — post-match code simplification.
 *
 * Two-phase approach:
 * 1. Canonicalize: deterministic AST passes (fast, removes obvious artifacts)
 * 2. Smell-budget permutation: concurrent mutation slots with smell scoring
 *
 * The hard constraint is always: compiled assembly must remain identical (score 0).
 */
import os from 'os';
import type { Language } from '~/language.js';
import { ensureLanguageRegistered, parse } from '~/parser.js';
import { MutationSearch } from '~/search/mutation-search.js';
import { SessionStore } from '~/session/store.js';
import type {
  AssemblyScoreResult,
  AvoidRegionConstraint,
  CandidateNode,
  FocusRegionConstraint,
  MutationSearchEvent,
  MutationSearchState,
  MutationTarget,
  StructuredDifference,
} from '~/types.js';

import { Canonicalizer, type CanonicalizerResult } from './canonicalizer.js';
import { type SmellBreakdown, countSmells } from './smell.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupOptions {
  /** Source code (must already match the target — score 0) */
  source: string;
  /** Source language (default: 'c') */
  language?: Language;
  /** Target function name */
  functionName: string;
  /** Path to the target object file (.o) */
  targetObjectPath: string;
  /** Shell command template for compilation */
  compilerCommand: string;
  /** Working directory for compiler */
  cwd: string;
  /** Content to prepend to source before compilation */
  sourcePrefix?: string;
  /** Compiler profile ID */
  profile?: string;
  /** Number of concurrent slots for Phase 2 (default: cpu count, max 4) */
  concurrency?: number;
  /** Max compile attempts for Phase 2 smell permutation (default: 50000) */
  maxCompiles?: number;
  /** Max time for Phase 2 in ms (default: 60000) */
  timeoutMs?: number;
  /** RNG seed */
  seed?: number;
  /** objdiff diff settings */
  diffSettings?: Record<string, string>;
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
  /** Event callback */
  onEvent?: CleanupEventHandler;
}

export interface CleanupResult {
  /** Cleaned source code */
  source: string;
  /** Phase 1 results */
  canonicalization: CanonicalizerResult;
  /** Phase 2 results (null if skipped) */
  smellPermutation: SmellPermutationResult | null;
  /** Smell breakdown before cleanup */
  smellBefore: SmellBreakdown;
  /** Smell breakdown after cleanup */
  smellAfter: SmellBreakdown;
  /** Total elapsed time in ms */
  elapsed: number;
}

export interface SmellPermutationResult {
  /** Whether Phase 2 improved the code */
  improved: boolean;
  /** Smell score before Phase 2 */
  smellBefore: number;
  /** Smell score after Phase 2 */
  smellAfter: number;
  /** Iterations run */
  iterations: number;
  /** Time spent in ms */
  elapsed: number;
}

export type CleanupEvent =
  | { type: 'phase1-started' }
  | { type: 'phase1-progress'; pass: string; applied: number }
  | { type: 'phase1-completed'; result: CanonicalizerResult; smellBefore: SmellBreakdown; smellAfter: SmellBreakdown }
  | { type: 'phase2-started'; smellScore: number }
  | { type: 'phase2-progress'; iteration: number; bestSmell: number }
  | { type: 'phase2-completed'; result: SmellPermutationResult }
  | { type: 'completed'; result: CleanupResult };

export type CleanupEventHandler = (event: CleanupEvent) => void;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Penalty added to assembly score when assembly doesn't match. */
const ASSEMBLY_MISMATCH_PENALTY = 999_999;

export class Cleanup {
  #opts: CleanupOptions;
  #abortController: AbortController;
  /** Active MutationSearch + SessionStore during Phase 2 (null otherwise). */
  #activeSearch: { search: MutationSearch; store: SessionStore } | null = null;

  constructor(opts: CleanupOptions) {
    this.#opts = opts;
    this.#abortController = new AbortController();

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.#abortController.abort(), { once: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Active sub-session access — same API surface as match and refine modes
  // ---------------------------------------------------------------------------

  /** Get the active Phase 2 MutationSearch + SessionStore, or null if not in Phase 2. */
  getActiveSearch(): { search: MutationSearch; store: SessionStore } | null {
    return this.#activeSearch;
  }

  pause(): void {
    this.#activeSearch?.search.pause();
  }

  resume(): void {
    this.#activeSearch?.search.resume();
  }

  async injectCode(
    source: string,
    options?: { label?: string },
  ): Promise<{ candidate: CandidateNode; target: MutationTarget } | null> {
    return this.#activeSearch?.search.injectCode(source, options) ?? null;
  }

  async getAssemblyDiff(source: string): Promise<{
    assembly: string;
    targetAssembly: string;
    diff: string;
    differences: string[];
    structuredDifferences: StructuredDifference[];
    differenceCount: number;
    matchingCount: number;
  } | null> {
    return this.#activeSearch?.search.getAssemblyDiff(source) ?? null;
  }

  setBranchWeight(mutationTargetId: string, weight: number): boolean {
    return this.#activeSearch?.search.setBranchWeight(mutationTargetId, weight) ?? false;
  }

  disableBranch(mutationTargetId: string): boolean {
    return this.#activeSearch?.search.disableBranch(mutationTargetId) ?? false;
  }

  enableBranch(mutationTargetId: string): boolean {
    return this.#activeSearch?.search.enableBranch(mutationTargetId) ?? false;
  }

  updateWeights(weights: Record<string, number>): string[] {
    return this.#activeSearch?.search.updateWeights(weights) ?? Object.keys(weights);
  }

  enableRule(ruleId: string): boolean {
    return this.#activeSearch?.search.enableRule(ruleId) ?? false;
  }

  disableRule(ruleId: string): boolean {
    return this.#activeSearch?.search.disableRule(ruleId) ?? false;
  }

  getRules(): { ruleId: string; description: string; weight: number; enabled: boolean }[] {
    return this.#activeSearch?.search.getRules() ?? [];
  }

  getBranchRuleHistory(branchId: string): { ruleId: string; trials: number; successRate: number }[] | null {
    return this.#activeSearch?.search.getBranchRuleHistory(branchId) ?? null;
  }

  setFocusConstraints(focusRegions: FocusRegionConstraint[], avoidRegions: AvoidRegionConstraint[]): void {
    this.#activeSearch?.search.setFocusConstraints(focusRegions, avoidRegions);
  }

  getFocusConstraints(): { focusRegions: FocusRegionConstraint[]; avoidRegions: AvoidRegionConstraint[] } {
    return this.#activeSearch?.search.getFocusConstraints() ?? { focusRegions: [], avoidRegions: [] };
  }

  setMutationDepth(depth: number): void {
    this.#activeSearch?.search.setMutationDepth(depth);
  }

  getMutationDepth(): number {
    return this.#activeSearch?.search.getMutationDepth() ?? 1;
  }

  summarize(): { removed: number; superNodes: unknown[]; removedTargetIds: string[] } {
    return this.#activeSearch?.search.summarize() ?? { removed: 0, superNodes: [], removedTargetIds: [] };
  }

  getState(): MutationSearchState {
    if (!this.#activeSearch) {
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
    return this.#activeSearch.search.getState();
  }

  async run(): Promise<CleanupResult> {
    const startTime = Date.now();
    const language = this.#opts.language ?? 'c';
    ensureLanguageRegistered(language);

    const emit = (event: CleanupEvent) => {
      try {
        this.#opts.onEvent?.(event);
      } catch {
        // Don't crash on consumer errors
      }
    };

    // Measure initial smell
    const initialRoot = parse(language, this.#opts.source);
    const smellBefore = countSmells(initialRoot, this.#opts.functionName);

    // Phase 1: Canonicalize
    emit({ type: 'phase1-started' });
    const canonicalizer = new Canonicalizer({
      source: this.#opts.source,
      language,
      functionName: this.#opts.functionName,
      targetObjectPath: this.#opts.targetObjectPath,
      compilerCommand: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      sourcePrefix: this.#opts.sourcePrefix,
      diffSettings: this.#opts.diffSettings,
      signal: this.#abortController.signal,
      onProgress(pass, applied) {
        emit({ type: 'phase1-progress', pass, applied });
      },
    });

    const canonResult = await canonicalizer.run();
    let source = canonResult.source;

    const postPhase1Root = parse(language, source);
    const smellAfterPhase1 = countSmells(postPhase1Root, this.#opts.functionName);
    emit({ type: 'phase1-completed', result: canonResult, smellBefore, smellAfter: smellAfterPhase1 });

    // Phase 2: Smell-budget permutation (concurrent, uses Pool + SlotOrchestrator)
    // Only run if there are still smells to fix and we haven't been aborted
    let smellResult: SmellPermutationResult | null = null;

    if (smellAfterPhase1.total > 0 && !this.#abortController.signal.aborted) {
      const phase2Result = await this.#phase2SmellPermutation(source, smellAfterPhase1.total, language, emit);
      smellResult = phase2Result.result;
      if (phase2Result.bestSource) {
        source = phase2Result.bestSource;
      }
    }

    const finalRoot = parse(language, source);
    const smellAfter = countSmells(finalRoot, this.#opts.functionName);

    const result: CleanupResult = {
      source,
      canonicalization: canonResult,
      smellPermutation: smellResult,
      smellBefore,
      smellAfter,
      elapsed: Date.now() - startTime,
    };

    emit({ type: 'completed', result });
    return result;
  }

  stop(): void {
    this.#abortController.abort();
  }

  /** Convert a CleanupResult into the serializable report format. */
  static toReportData(sourceBefore: string, result: CleanupResult): import('~/types.js').CleanupReportData {
    return {
      sourceBefore,
      sourceAfter: result.source,
      canonicalization: {
        passes: result.canonicalization.passes,
        totalApplied: result.canonicalization.totalApplied,
      },
      smellPermutation: result.smellPermutation,
      smellBefore: result.smellBefore,
      smellAfter: result.smellAfter,
      elapsed: result.elapsed,
    };
  }

  /**
   * Phase 2: Concurrent smell-budget permutation.
   *
   * Delegates to MutationSearch with a scoreTransform that replaces the
   * assembly diff score with the smell score when assembly matches, and
   * applies a high penalty when it doesn't.
   */
  async #phase2SmellPermutation(
    source: string,
    currentSmell: number,
    language: Language,
    emit: (event: CleanupEvent) => void,
  ): Promise<{ result: SmellPermutationResult; bestSource: string | null }> {
    const startTime = Date.now();
    emit({ type: 'phase2-started', smellScore: currentSmell });

    const concurrency = this.#opts.concurrency ?? Math.min(os.cpus().length, 4);
    const maxCompiles = this.#opts.maxCompiles ?? 50_000;
    const timeoutMs = this.#opts.timeoutMs ?? 60_000;
    const seed = this.#opts.seed ?? Math.floor(Math.random() * 0xffffffff);
    const functionName = this.#opts.functionName;

    let bestSmell = currentSmell;

    const scoreTransform = (mutationSource: string, asmResult: AssemblyScoreResult): number => {
      if (asmResult.score !== 0) {
        return ASSEMBLY_MISMATCH_PENALTY + asmResult.score;
      }
      const root = parse(language, mutationSource);
      return countSmells(root, functionName).total;
    };

    const subStore = new SessionStore({
      metadata: {
        sessionId: `cleanup-phase2`,
        label: `Cleanup Phase 2`,
      },
    });
    subStore.setOriginalSource(source);

    const search = new MutationSearch({
      source,
      language,
      functionName,
      targetObjectPath: this.#opts.targetObjectPath,
      compilerCommand: this.#opts.compilerCommand,
      cwd: this.#opts.cwd,
      sourcePrefix: this.#opts.sourcePrefix,
      profile: this.#opts.profile,
      diffSettings: this.#opts.diffSettings,
      concurrency,
      maxCompiles,
      timeoutMs,
      seed,
      mutationDepth: 2,
      lateralForkBudget: 5,
      scoreTransform,
      ruleWeights: {
        'delete-stmt': 50,
        'remove-cast': 40,
        'expand-expr': 40,
        'shift-div-swap': 30,
        'compound-return': 30,
        'commutative-swap': 10,
        'self-assignment': 0,
        'pad-var-decl': 0,
        'insert-block': 0,
        'empty-stmt': 0,
        'duplicate-assignment': 0,
        'long-chain-assignment': 0,
        'temp-for-expr': 0,
        'mult-zero': 0,
        'xor-zero': 0,
        'cast-expr': 0,
        'extra-parens': 0,
        'void-cast': 0,
        'add-mask': 0,
        'asm-barrier': 0,
        'asm-register-swap': 0,
        'randomize-type': 0,
        'float-literal': 0,
      },
      signal: this.#abortController.signal,
      onEvent(event: MutationSearchEvent) {
        subStore.push(event);
        if (event.type === 'forked') {
          if (event.newScore < bestSmell) {
            bestSmell = event.newScore;
          }
          emit({ type: 'phase2-progress', iteration: event.iteration, bestSmell });
        }
        if (event.type === 'stats') {
          emit({ type: 'phase2-progress', iteration: event.iteration, bestSmell });
        }
      },
    });

    this.#activeSearch = { search, store: subStore };
    const searchResult = await search.start();
    this.#activeSearch = null;

    const improved = searchResult.bestScore < currentSmell;
    const smellPermResult: SmellPermutationResult = {
      improved,
      smellBefore: currentSmell,
      smellAfter: searchResult.bestScore,
      iterations: searchResult.totalIterations,
      elapsed: Date.now() - startTime,
    };

    emit({ type: 'phase2-completed', result: smellPermResult });
    return { result: smellPermResult, bestSource: improved ? searchResult.bestSource : null };
  }
}
