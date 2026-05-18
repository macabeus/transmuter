/**
 * Core types for Transmuter.
 *
 * Naming convention: every term here is used identically in code, docs, and UI.
 * See ARCHITECTURE.md glossary.
 */
import type { Language } from './language.js';

export type { Language } from './language.js';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Classification of an instruction-level assembly difference. */
export type DiffType = 'insert' | 'delete' | 'replace' | 'opMismatch' | 'argMismatch';

/** A single structured instruction-level difference between candidate and target. */
export interface StructuredDifference {
  /** Row index in the instruction diff (0-based) */
  readonly row: number;
  /** Classification of the difference */
  readonly type: DiffType;
  /** Instruction text from the candidate side (empty string if absent) */
  readonly candidateInstruction: string;
  /** Instruction text from the target side (empty string if absent) */
  readonly targetInstruction: string;
}

/** Breakdown of assembly differences by type. */
export interface DiffBreakdown {
  readonly total: number;
  readonly insert: number;
  readonly delete: number;
  readonly replace: number;
  readonly opMismatch: number;
  readonly argMismatch: number;
}

/** Structured result from assembly scoring. */
export interface AssemblyScoreResult {
  readonly score: number;
  readonly breakdown: DiffBreakdown;
  readonly assembly: string;
  readonly assemblyDiff: string;
}

// ---------------------------------------------------------------------------
// Candidate Graph
// ---------------------------------------------------------------------------

/** An immutable snapshot of code at a point in the candidate graph. */
export interface CandidateNode {
  /** Unique candidate ID */
  readonly id: string;
  /** Source code */
  readonly source: string;
  /** objdiff score (lower = better, 0 = perfect match) */
  readonly score: number;
  /** Iteration when this candidate was created */
  readonly iteration: number;
  /** Wall-clock timestamp (ms) */
  readonly timestamp: number;
  /** ID of the MutationTarget this candidate belongs to (set once after creation) */
  mutationTargetId: string;
  /** Parent candidate ID (undefined only for genesis and external roots) */
  readonly parentId?: string;
  /** How this candidate was created */
  readonly origin: 'genesis' | 'organic' | 'external';
  /** Mutation rule that produced this candidate (organic only) */
  readonly ruleId?: string;
  /** AST location where the mutation was applied (organic only, 1-indexed) */
  readonly location?: { line: number; column: number };
  /** Label for external candidates (e.g., "user hypothesis", "Claude suggestion") */
  readonly externalLabel?: string;
  /** Assembly text for this candidate's compiled output */
  readonly assembly: string;
  /** Objdiff differences against the target (detailed, line-by-line) */
  readonly assemblyDiff: string;
  /** Breakdown of assembly differences by type */
  readonly breakdown: DiffBreakdown;
}

/**
 * A candidate being actively targeted for mutations.
 * The candidate it points to never changes — all improvements create new
 * MutationTargets on new candidates (forking).
 */
export interface MutationTarget {
  /** Unique target ID */
  readonly id: string;
  /** The candidate being mutated */
  readonly candidateId: string;
  /** Scheduling weight — higher = more mutation turns (default: 1) */
  weight: number;
  /** Whether this target participates in scheduling */
  enabled: boolean;
  /** Total mutations attempted on this target */
  attempts: number;
  /** Mutations attempted since the last fork (reset to 0 on each fork). Used by auto-compact staleness detection. */
  attemptsWithoutFork: number;
  /** Timestamp (ms) when this target was created */
  readonly createdAt: number;
  /** Global iteration at which this target last produced a fork, or null if never. */
  lastImprovedAtIteration: number | null;
}

/**
 * A summarized group of pruned candidates, replacing a dead-end subtree.
 *
 * Created by graph summarization (compaction). Preserves aggregate statistics
 * so the report remains useful without retaining every candidate in memory.
 */
export interface SuperNode {
  /** Unique supernode ID (e.g. "supernode-{parentCandidateId}" or "supernode-root-{rootId}") */
  readonly id: string;
  /** ID of the surviving candidate this supernode branches from, or undefined for summarized root trees */
  readonly parentId?: string;
  /** Number of candidates that were summarized (removed) */
  readonly summarizedCount: number;
  /** Best (lowest) score among the summarized candidates */
  readonly bestScore: number;
  /** Worst (highest) score among the summarized candidates */
  readonly worstScore: number;
  /** Distinct mutation rule IDs that produced candidates in this group */
  readonly rules: readonly string[];
  /** Source code of the best-scoring candidate in the group */
  readonly bestSource: string;
}

/** Statistics from the Pool */
export interface PoolStats {
  readonly targetCount: number;
  readonly activeTargetCount: number;
  readonly candidateCount: number;
  readonly bestScore: number;
  readonly totalAttempts: number;
  readonly targets: readonly MutationTargetSummary[];
}

export interface MutationTargetSummary {
  readonly id: string;
  readonly candidateId: string;
  readonly score: number;
  readonly weight: number;
  readonly enabled: boolean;
  readonly attempts: number;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Location of the AST node a rule targeted (1-indexed). */
export interface MutationLocation {
  readonly line: number;
  readonly column: number;
}

/** Result of applying a mutation rule. */
export interface MutationApplyResult {
  /** Mutated source code */
  readonly source: string;
  /** Location of the AST node the rule targeted */
  readonly location: MutationLocation;
}

/** Result of the mutation engine (may chain multiple rules). */
export interface MutationResult {
  /** Mutated source code */
  readonly source: string;
  /** IDs of rules applied (1 per depth level) */
  readonly ruleIds: readonly string[];
  /** Location from the last applied rule */
  readonly location: MutationLocation;
}

/** What the pool receives after scoring a mutation */
export interface MutationReport {
  readonly mutationTargetId: string;
  readonly source: string;
  readonly score: number;
  readonly breakdown: DiffBreakdown;
  readonly ruleId: string;
  readonly location: MutationLocation;
  readonly assembly: string;
  readonly assemblyDiff: string;
}

// ---------------------------------------------------------------------------
// Focus Constraints
// ---------------------------------------------------------------------------

/** A directive that biases Transmuter's mutation selection. */
export type FocusConstraint = FocusRegionConstraint | AvoidRegionConstraint | HypothesisConstraint;

export interface FocusRegionConstraint {
  readonly type: 'focus-region';
  readonly id: string;
  readonly description: string;
  readonly lines: { readonly start: number; readonly end: number };
  /** Bias strength (0-1). 1 = only mutate within this region. Default: 0.7 */
  readonly strength?: number;
}

export interface AvoidRegionConstraint {
  readonly type: 'avoid-region';
  readonly id: string;
  readonly description: string;
  readonly lines: { readonly start: number; readonly end: number };
}

export interface HypothesisConstraint {
  readonly type: 'hypothesis';
  readonly id: string;
  readonly description: string;
  readonly source: string;
  /** If true, inject as a new mutation target (default: true) */
  readonly injectAsBranch?: boolean;
}

// ---------------------------------------------------------------------------
// Events (Library -> Consumer)
// ---------------------------------------------------------------------------

export type MutationSearchEvent =
  | { type: 'started'; baseScore: number; targetCount: number; ruleDescriptions: Record<string, string> }
  | { type: 'scored'; iteration: number; score: number; ruleId: string; mutationTargetId: string }
  | {
      type: 'forked';
      iteration: number;
      parentCandidateId: string;
      candidateId: string;
      mutationTargetId: string;
      oldScore: number;
      newScore: number;
      source: string;
      ruleId: string;
      location: MutationLocation;
      assembly: string;
      assemblyDiff: string;
      breakdown: DiffBreakdown;
    }
  | { type: 'perfect-match'; iteration: number; source: string; candidateId: string }
  | { type: 'compilation-error'; mutationTargetId: string; ruleId: string; error: string }
  | { type: 'scorer-failed'; mutationTargetId: string; ruleId: string; error: string }
  | {
      type: 'stats';
      iteration: number;
      elapsed: number;
      targets: readonly MutationTargetSummary[];
      bestScore: number;
      candidateCount: number;
      compiled: number;
      errors: number;
      deduped: number;
      rulesUsed: Record<string, number>;
    }
  | {
      type: 'completed';
      reason: MutationSearchResult['reason'];
      finalScore: number;
      totalIterations: number;
      elapsed: number;
      bestSource: string;
    }
  | { type: 'error'; message: string }
  | { type: 'focus-mutation'; constraintId: string; ruleId: string; improved: boolean }
  | { type: 'focus-rejected'; constraintId: string; ruleId: string; reason: 'avoid-region' }
  | { type: 'hypothesis-scored'; constraintId: string; score: number; mutationTargetId?: string }
  | {
      type: 'mutation-target-created';
      mutationTargetId: string;
      candidateId: string;
      score: number;
      origin: CandidateNode['origin'];
      source?: string;
      assembly?: string;
      assemblyDiff?: string;
      breakdown?: DiffBreakdown;
    }
  | { type: 'mutation-target-disabled'; mutationTargetId: string }
  | { type: 'mutation-target-enabled'; mutationTargetId: string }
  | { type: 'mutation-target-weight-changed'; mutationTargetId: string; weight: number }
  | { type: 'graph-summarized'; removedCount: number; superNodeCount: number }
  | { type: 'auto-compacted'; disabled: number; removed: number; superNodes: number };

export type MutationSearchEventHandler = (event: MutationSearchEvent) => void;

// ---------------------------------------------------------------------------
// Options & Result
// ---------------------------------------------------------------------------

export interface MutationSearchOptions {
  /** Source code to permute */
  source: string;
  /** Source language (default: 'c') */
  language?: Language;
  /** Name of the target function in the source */
  functionName: string;
  /** Path to the target object file (.o) */
  targetObjectPath: string;
  /**
   * Shell command template for compilation.
   * Placeholders: {{inputPath}}, {{outputPath}}, {{functionName}}
   */
  compilerCommand: string;
  /** Working directory for compiler command execution */
  cwd: string;
  /**
   * Content to prepend to every source file before compilation.
   * Typically type definitions and extern declarations (context.h).
   * Read once and cached — avoids a `cat` subprocess per compilation.
   */
  sourcePrefix?: string;
  /** Compiler profile ID (e.g., 'agbcc', 'ido', 'mips-gcc-272') */
  profile?: string;
  /**
   * Number of concurrent slots. Each slot runs in its own Bun Worker thread
   * (parallel CPU + parallel compile subprocesses). Default:
   * `min(os.cpus().length, 4)`. Use `concurrency: 1` with a fixed `seed` and
   * `maxCompiles` for bit-identical reproducible runs.
   */
  concurrency?: number;
  /**
   * Maximum compile attempts before stopping (default: Infinity). One
   * attempt = one mutation that survived dedup and reached `compiler.compile()`.
   * Mutations that early-exit on no-mutation or dedup do NOT count against
   * this budget. Matches Permuter's per-compile counting (Permuter has no
   * dedup early-exit, so its iterations are always compile attempts).
   *
   * In-flight overshoot: with prefetch, up to `concurrency × prefetchDepth`
   * jobs can complete after the threshold is crossed, so the actual stop
   * point is approximate.
   */
  maxCompiles?: number;
  /** Maximum time in ms before stopping (default: Infinity) */
  timeoutMs?: number;
  /** Seed for deterministic reproduction (default: random) */
  seed?: number;
  /** Rule weight overrides: { ruleId: weight } */
  ruleWeights?: Record<string, number>;
  /** Rule IDs to disable */
  disabledRules?: string[];
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
  /** objdiff-wasm diff settings */
  diffSettings?: Record<string, string>;
  /** Number of mutations to chain per iteration (default: 1) */
  mutationDepth?: number;
  /**
   * Maximum number of lateral forks (same-score branches) per mutation target.
   * Lateral forks allow exploring code plateaus where intermediate transformations
   * don't improve the score but are stepping stones to a better solution.
   * Default: 0 (only fork on strict improvement).
   */
  lateralForkBudget?: number;
  /** Event callback */
  onEvent?: MutationSearchEventHandler;
  /** Focus constraints to bias mutation selection */
  focusConstraints?: FocusConstraint[];
  /**
   * Optional filter applied to each mutated candidate before compilation.
   * Return false to reject the candidate (e.g., to prevent re-introducing a violation).
   */
  candidateFilter?: (source: string) => boolean;
  /**
   * Optional score transform applied after assembly scoring.
   * Receives the mutation source and the full AssemblyScoreResult (including
   * breakdown by diff type), returns the final score used for pool reporting
   * and fork decisions.
   * Use case: cleanup returns smell score when assembly matches (asmScore == 0)
   * and a high penalty when it doesn't.
   */
  scoreTransform?: (source: string, asmResult: AssemblyScoreResult) => number;
  /** Options for adaptive per-target rule selection (Thompson Sampling). Always enabled. */
  adaptiveSelection?: AdaptiveSelectorOptions;
  /**
   * Maximum worker results without producing a single fork before stopping.
   * Useful when a candidateFilter rejects all mutations (e.g., refine mode
   * for asm constructs) and no compile would have succeeded anyway. This is
   * counted in raw worker results (including dedup/no-mutation) since the
   * concern is "engine spinning forever without traction" — not compile work.
   * Default: undefined (no limit).
   */
  maxUnproductiveResults?: number;
  /**
   * Automatic pruning and compaction policy. Periodically prunes stale targets
   * (no fork in many attempts) and compacts dead-end subtrees into supernodes.
   * Enabled by default with sensible defaults. Pass `false` to disable.
   */
  autoCompact?: AutoCompactPolicy | false;
}

/** Policy for automatic pruning and compaction of dead branches. */
export interface AutoCompactPolicy {
  /**
   * Base staleness threshold. A target is "stale" after this many attempts without
   * producing a fork. The effective threshold is adaptive: it decreases as the active
   * target pool grows (to compensate for per-target attempt dilution) and increases as
   * the pool shrinks (to avoid over-pruning). Formula:
   *   effective = max(minStaleThreshold, staleAfterAttempts / sqrt(activeTargets / concurrency))
   * Default: 500.
   */
  staleAfterAttempts?: number;
  /**
   * Floor for the adaptive staleness threshold. Prevents overly aggressive pruning
   * when the pool is very large. Default: 20.
   */
  minStaleThreshold?: number;
  /** Always keep at least this many active targets (best-scoring survive). Clamped to min 1. Default: 3 */
  keepMinTargets?: number;
  /** Only evaluate staleness when the graph has at least this many candidates. Default: 200 */
  candidateThreshold?: number;
}

export interface MutationSearchResult {
  /** Whether a perfect match (score 0) was found */
  readonly perfectMatch: boolean;
  /** Best score achieved */
  readonly bestScore: number;
  /** Source code with the best score */
  readonly bestSource: string;
  /** Baseline score (score of the original input source) */
  readonly baseScore: number;
  /** Total iterations run */
  readonly totalIterations: number;
  /** Total wall-clock time in ms */
  readonly elapsed: number;
  /** Reason the job ended */
  readonly reason: 'perfect-match' | 'max-compiles' | 'timeout' | 'aborted' | 'exhausted';
}

export interface MutationSearchState {
  running: boolean;
  paused: boolean;
  functionName: string;
  iteration: number;
  elapsed: number;
  bestScore: number;
  bestSource: string;
  targets: MutationTarget[];
  ruleWeights: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Adaptive Selection
// ---------------------------------------------------------------------------

export interface AdaptiveSelectorOptions {
  /** Sliding window size for recent trials per rule per target. Default: 500. */
  readonly windowSize?: number;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export type CompileResult = { success: true; objPath: string } | { success: false; error: string };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export interface ReducerOptions {
  /** Full C source file */
  source: string;
  /** Target function name */
  functionName: string;
  /** Path to the target object file */
  targetObjectPath: string;
  /** Compiler command template */
  compilerCommand: string;
  /** Working directory */
  cwd: string;
  /**
   * Content to prepend to every source file before compilation.
   * Must match what the downstream MutationSearch uses, otherwise the reducer's
   * baseline compile will fail for any source that depends on prefix-supplied
   * types or extern declarations.
   */
  sourcePrefix?: string;
  /** Progress callback */
  onProgress?: (phase: string, removed: number, total: number) => void;
  /** objdiff diff settings */
  diffSettings?: Record<string, string>;
}

export interface ReducerResult {
  /** Minimized source code */
  readonly source: string;
  /** Original source size (bytes) */
  readonly originalSize: number;
  /** Reduced source size (bytes) */
  readonly reducedSize: number;
  /** Number of items removed per phase */
  readonly removals: readonly { readonly phase: string; readonly count: number }[];
}

// ---------------------------------------------------------------------------
// Cleanup Report Data (embedded in session/refinement reports)
// ---------------------------------------------------------------------------

export interface CleanupReportData {
  /** Source code before cleanup */
  sourceBefore: string;
  /** Source code after cleanup */
  sourceAfter: string;
  /** Canonicalization passes applied (Phase 1) */
  canonicalization: {
    passes: { name: string; applied: number }[];
    totalApplied: number;
  };
  /** Smell permutation results (Phase 2), null if skipped */
  smellPermutation: {
    improved: boolean;
    smellBefore: number;
    smellAfter: number;
    iterations: number;
    elapsed: number;
  } | null;
  /** Smell breakdown before cleanup */
  smellBefore: {
    total: number;
    tempVariables: number;
    casts: number;
    doWhileZero: number;
    singleUseVariables: number;
    statementCount: number;
  };
  /** Smell breakdown after cleanup */
  smellAfter: {
    total: number;
    tempVariables: number;
    casts: number;
    doWhileZero: number;
    singleUseVariables: number;
    statementCount: number;
  };
  /** Total elapsed time in ms */
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Session Report (queryable store output)
// ---------------------------------------------------------------------------

export interface SessionReport {
  readonly version: 1;
  readonly type: 'match';
  readonly metadata: SessionMetadata;
  readonly config: SessionConfig;
  readonly summary: SessionSummary;
  readonly graph: {
    readonly candidates: readonly CandidateNode[];
    readonly mutationTargets: readonly MutationTarget[];
    readonly superNodes?: readonly SuperNode[];
  };
  readonly ruleStats: readonly RuleStatsEntry[];
  readonly scoreTimeline: readonly TimelinePoint[];
  readonly focusResults: readonly FocusResult[];
  /** Post-match cleanup results (present when --cleanup was used) */
  readonly cleanup?: CleanupReportData;
  /**
   * Pre-isolation source of the input TU. Present when `--isolate` was used,
   * letting the webapp show the unmodified context alongside each candidate's
   * isolated source.
   */
  readonly contextSource?: string;
}

export interface SessionMetadata {
  readonly sessionId: string;
  readonly label?: string;
  readonly tags?: readonly string[];
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly partial?: { readonly iteration: number; readonly elapsed: number };
}

export interface SessionConfig {
  readonly functionName: string;
  readonly targetObjectPath: string;
  readonly compilerCommand: string;
  readonly language: Language;
  readonly profile?: string;
  readonly concurrency: number;
  readonly maxCompiles: number;
  readonly timeoutMs: number;
  readonly seed: number;
  readonly mutationDepth: number;
  readonly lateralForkBudget: number;
  readonly ruleWeights: Readonly<Record<string, number>>;
  readonly disabledRules: readonly string[];
  readonly focusConstraints: readonly FocusConstraint[];
}

export interface SessionSummary {
  readonly baseScore: number;
  readonly bestScore: number;
  readonly scoreDelta: number;
  readonly perfectMatch: boolean;
  readonly totalIterations: number;
  readonly elapsed: number;
  readonly totalCompiled: number;
  readonly totalErrors: number;
  readonly totalDeduped: number;
  readonly forkCount: number;
  readonly targetCount: number;
  readonly activeTargetCount: number;
  readonly completionReason?: string;
  readonly avgForkInterval: number;
}

export interface RuleStatsEntry {
  readonly ruleId: string;
  readonly description: string;
  readonly applied: number;
  readonly forked: number;
  readonly successRate: number;
  readonly avgDelta: number;
  readonly bestDelta: number;
  readonly errors: number;
  readonly focusApplied: number;
  readonly focusForked: number;
  readonly deltaByType: {
    readonly insert: number;
    readonly delete: number;
    readonly replace: number;
    readonly opMismatch: number;
    readonly argMismatch: number;
  };
}

export interface TimelinePoint {
  readonly iteration: number;
  readonly elapsed: number;
  readonly bestScore: number;
  readonly targetCount: number;
  readonly candidateCount: number;
  readonly compiledTotal: number;
}

export interface FocusResult {
  readonly constraintId: string;
  readonly constraint: FocusConstraint;
  readonly mutationsAttempted: number;
  readonly mutationsForked: number;
  readonly mutationsRejected: number;
  readonly bestRegionScore?: number;
  readonly hypothesisScore?: number;
  readonly hypothesisMutationTargetId?: string;
  readonly summary: string;
}

export interface SessionStoreOptions {
  metadata?: {
    sessionId?: string;
    label?: string;
    tags?: string[];
  };
  focusConstraints?: FocusConstraint[];
}

// ---------------------------------------------------------------------------
// Refinement Report
// ---------------------------------------------------------------------------

export interface RefinementReport {
  readonly version: 1;
  readonly type: 'refinement';
  readonly metadata: SessionMetadata;
  readonly config: RefinementConfig;
  readonly guideline: { readonly id: string; readonly description: string };
  readonly violations: readonly ViolationReport[];
  readonly mergeLog: readonly MergeLogEntry[];
  readonly finalResult: RefinementResult;
  /** Per-violation focus constraint results from sub-permuters, keyed by violationId */
  readonly focusResults?: Readonly<Record<string, readonly FocusResult[]>>;
  /** Aggregated rule stats across all sub-permuter sessions */
  readonly ruleStats: readonly RuleStatsEntry[];
  /** Post-refinement cleanup results (present when --cleanup was used) */
  readonly cleanup?: CleanupReportData;
}

export interface RefinementConfig {
  readonly functionName: string;
  readonly targetObjectPath: string;
  readonly compilerCommand: string;
  readonly language: Language;
  readonly profile?: string;
  readonly guidelineId: string;
  readonly concurrency: number;
  readonly maxCompilesPerViolation: number;
  readonly timeoutMsPerViolation: number;
  readonly seed: number;
}

export interface ViolationReport {
  id: string;
  lines: { start: number; end: number };
  description: string;
  originalText: string;
  status:
    | 'pending'
    | 'exploring'
    | 'fixed'
    | 'removal-failed'
    | 'transmuter-exhausted'
    | 'trivially-fixed'
    | 'resolved-by-prior';
  /** Source with only this violation fixed (Phase 1 result) */
  fixedSource?: string;
  /** Diff between original and fixed source */
  fixDiff?: string;
  /** Live exploration progress (updated in real-time during Phase 1/2 permutation) */
  liveProgress?: {
    iteration: number;
    score: number;
  };
  /** Phase 1 permuter stats (populated after exploration completes) */
  exploration?: {
    iterations: number;
    elapsed: number;
    finalScore: number;
    scoreAfterRemoval: number;
    /** Full sub-session report from the internal MutationSearch run */
    subSession?: SessionReport;
    /** Side-by-side assembly diff between best candidate and target */
    assemblyDiff?: string;
  };
}

export interface MergeLogEntry {
  step: number;
  violationId: string;
  action: 'skipped-already-resolved' | 'applied-trivially' | 'permuted' | 'failed';
  iterations?: number;
  elapsed?: number;
  /** Source after this merge step (if successful) */
  sourceAfter?: string;
  /** Diff from previous step */
  diff?: string;
}

/**
 * A violation whose Phase 1 fix is ready but has not yet been merged into the
 * spine. Populated for violations whose status is `'fixed'` or `'trivially-fixed'`
 * and whose `id` does not yet appear in the merge log. Drains to empty after
 * Phase 2 finishes (every fix becomes a `MergeLogEntry`).
 */
export interface PendingMerge {
  readonly violationId: string;
  readonly status: 'fixed' | 'trivially-fixed';
  /**
   * The fix that will be merged. May be `undefined` for `status: 'fixed'`
   * during the brief window between the `violation-fixed` event and the
   * post-Phase-1 `updateViolationFix()` call that attaches the source.
   */
  readonly fixedSource?: string;
}

export interface RefinementResult {
  readonly source: string;
  readonly violationsFixed: number;
  readonly violationsTotal: number;
  readonly trivialFixes: number;
  readonly permutedFixes: number;
  readonly resolvedByPrior: number;
  readonly notFixable: number;
  readonly elapsed: number;
}

// ---------------------------------------------------------------------------
// Refinement Events
// ---------------------------------------------------------------------------

export type RefinerEvent =
  | { type: 'sanity-check-passed'; score: number }
  | { type: 'sanity-check-failed'; score: number; error: string }
  | { type: 'violations-detected'; count: number; violations: { id: string; description: string }[] }
  | { type: 'violation-fix-started'; violationId: string }
  | {
      type: 'violation-hypothesis-scored';
      violationId: string;
      hypothesisId: string;
      description: string;
      score: number;
    }
  | { type: 'violation-fix-progress'; violationId: string; iteration: number; score: number }
  | { type: 'violation-trivially-fixed'; violationId: string; fixedSource: string }
  | { type: 'violation-fixed'; violationId: string; iterations: number; elapsed: number }
  | { type: 'violation-removal-failed'; violationId: string; reason: string }
  | { type: 'violation-transmuter-exhausted'; violationId: string; bestScore: number; iterations: number }
  | { type: 'merge-started' }
  | { type: 'merge-step'; step: number; violationId: string; action: MergeLogEntry['action'] }
  | { type: 'completed'; result: RefinementResult };

export type RefinerEventHandler = (event: RefinerEvent) => void;

// ---------------------------------------------------------------------------
// Refinement Options
// ---------------------------------------------------------------------------

export interface RefinerOptions {
  /** Source code (must already match the target) */
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
  /** Guideline ID to apply */
  guidelineId: string;
  /** Total concurrent slots (split across violations in Phase 1) */
  concurrency?: number;
  /** Max compile attempts per violation (default: Infinity) */
  maxCompilesPerViolation?: number;
  /** Max time per violation in ms (default: Infinity) */
  timeoutMsPerViolation?: number;
  /** RNG seed */
  seed?: number;
  /** objdiff diff settings */
  diffSettings?: Record<string, string>;
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
  /** Event callback */
  onEvent?: RefinerEventHandler;
  /** Skip merge phase — only run exploration */
  skipMerge?: boolean;
  /** Focus constraints passed through to each violation's sub-permuter */
  focusConstraints?: FocusConstraint[];
  /** Per-violation hypothesis code to inject as mutation targets in the sub-permuter */
  violationHypotheses?: ViolationHypothesis[];
}

export interface ViolationHypothesis {
  /** Must match a violation ID from the guideline's detect() output */
  readonly violationId: string;
  /** Source code to try as a hypothesis */
  readonly source: string;
  /** Description for LLM context */
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Collapsed Graph
// ---------------------------------------------------------------------------

/** A node on the winning lineage in the collapsed graph view. */
export interface SpineNode {
  /** The candidate on the winning path */
  readonly candidate: CandidateNode;
  /** Non-spine branches from this node, collapsed into a cluster summary */
  readonly cluster: ClusterSummary | null;
}

/** Summary of a collapsed branch off the winning lineage. */
export interface ClusterSummary {
  /** Unique ID for this cluster (derived from the spine candidate ID) */
  readonly id: string;
  /** Number of candidates in this subtree (excluding the spine node), including summarized */
  readonly candidateCount: number;
  /** Best (lowest) score achieved in this cluster */
  readonly bestScore: number;
  /** Worst (highest) score in this cluster */
  readonly worstScore: number;
  /** Distinct mutation rules that produced candidates in this cluster */
  readonly rules: readonly string[];
  /** All candidates in this cluster (for expand-on-demand) */
  readonly candidates: readonly CandidateNode[];
  /** Summarized dead branches within this cluster (from graph compaction) */
  readonly superNodes?: readonly SuperNode[];
}

/** Collapsed graph: the winning lineage as a spine with off-spine clusters. */
export interface CollapsedGraph {
  /** Winning lineage from genesis to best candidate (ordered) */
  readonly spine: readonly SpineNode[];
  /** Total candidates in the full graph */
  readonly totalCandidates: number;
  /** How many candidates were collapsed into clusters */
  readonly collapsedCount: number;
  /** Supernodes from dead injection trees with no active lineage (parentId undefined) */
  readonly disconnectedSuperNodes?: readonly SuperNode[];
}

/** Union type for report discrimination */
export type Report = SessionReport | RefinementReport;
