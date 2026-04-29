/**
 * Report types for the webapp.
 *
 * The webapp reads report JSON — these types match the serialized
 * structures from @transmuter/core.
 */

// ---------------------------------------------------------------------------
// Candidate Graph
// ---------------------------------------------------------------------------

export interface CandidateNode {
  id: string;
  source: string;
  score: number;
  iteration: number;
  timestamp: number;
  mutationTargetId: string;
  parentId?: string;
  origin: 'genesis' | 'organic' | 'external';
  ruleId?: string;
  location?: { line: number; column: number };
  externalLabel?: string;
  /** Assembly text for this candidate's compiled output */
  assembly: string;
  /** Objdiff differences against the target (detailed, line-by-line) */
  assemblyDiff: string;
  /** Breakdown of assembly differences by type */
  breakdown: DiffBreakdown;
}

export interface DiffBreakdown {
  total: number;
  insert: number;
  delete: number;
  replace: number;
  opMismatch: number;
  argMismatch: number;
}

export interface MutationTarget {
  id: string;
  candidateId: string;
  weight: number;
  enabled: boolean;
  attempts: number;
  createdAt: number;
}

export interface SuperNode {
  id: string;
  parentId?: string;
  summarizedCount: number;
  bestScore: number;
  worstScore: number;
  rules: string[];
  bestSource: string;
}

// ---------------------------------------------------------------------------
// Session Report
// ---------------------------------------------------------------------------

export interface SessionReport {
  version: 1;
  type: 'match';
  metadata: SessionMetadata;
  config: SessionConfig;
  summary: SessionSummary;
  graph: {
    candidates: CandidateNode[];
    mutationTargets: MutationTarget[];
    superNodes?: SuperNode[];
  };
  ruleStats: RuleStatsEntry[];
  scoreTimeline: TimelinePoint[];
  focusResults: FocusResult[];
  cleanup?: CleanupReportData;
}

export interface SessionMetadata {
  sessionId: string;
  label?: string;
  tags?: string[];
  createdAt: string;
  completedAt?: string;
  partial?: { iteration: number; elapsed: number };
}

export type Language = 'c' | 'cpp' | 'pascal';

export interface SessionConfig {
  functionName: string;
  targetObjectPath: string;
  compilerCommand: string;
  language?: Language;
  profile?: string;
  concurrency: number;
  maxCompiles: number;
  timeoutMs: number;
  seed: number;
  mutationDepth: number;
  ruleWeights: Record<string, number>;
  disabledRules: string[];
  focusConstraints: FocusConstraint[];
}

export interface SessionSummary {
  baseScore: number;
  bestScore: number;
  scoreDelta: number;
  perfectMatch: boolean;
  totalIterations: number;
  elapsed: number;
  totalCompiled: number;
  totalErrors: number;
  totalDeduped: number;
  forkCount: number;
  targetCount: number;
  activeTargetCount: number;
  completionReason?: string;
  avgForkInterval: number;
}

export interface RuleStatsEntry {
  ruleId: string;
  description: string;
  applied: number;
  forked: number;
  successRate: number;
  avgDelta: number;
  bestDelta: number;
  errors: number;
  focusApplied: number;
  focusForked: number;
  deltaByType?: { insert: number; delete: number; replace: number; opMismatch: number; argMismatch: number };
}

export interface TimelinePoint {
  iteration: number;
  elapsed: number;
  bestScore: number;
  targetCount: number;
  candidateCount: number;
  compiledTotal: number;
}

export type FocusConstraint =
  | { type: 'focus-region'; id: string; description: string; lines: { start: number; end: number }; strength?: number }
  | { type: 'avoid-region'; id: string; description: string; lines: { start: number; end: number } }
  | { type: 'hypothesis'; id: string; description: string; source: string; injectAsBranch?: boolean };

export interface FocusResult {
  constraintId: string;
  constraint: FocusConstraint;
  mutationsAttempted: number;
  mutationsForked: number;
  mutationsRejected: number;
  bestRegionScore?: number;
  hypothesisScore?: number;
  hypothesisMutationTargetId?: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Refinement Report
// ---------------------------------------------------------------------------

export interface RefinementReport {
  version: 1;
  type: 'refinement';
  metadata: SessionMetadata;
  config: RefinementConfig;
  guideline: { id: string; description: string };
  violations: ViolationReport[];
  mergeLog: MergeLogEntry[];
  finalResult: RefinementResult;
  /** Per-violation focus constraint results from sub-permuters, keyed by violationId */
  focusResults?: Record<string, FocusResult[]>;
  /** Aggregated rule stats across all sub-permuter sessions */
  ruleStats: RuleStatsEntry[];
  /** Post-refinement cleanup results */
  cleanup?: CleanupReportData;
}

export interface RefinementConfig {
  functionName: string;
  targetObjectPath: string;
  compilerCommand: string;
  language?: Language;
  profile?: string;
  guidelineId: string;
  concurrency: number;
  maxCompilesPerViolation: number;
  timeoutMsPerViolation: number;
  seed: number;
}

export interface ViolationReport {
  id: string;
  lines: { start: number; end: number };
  description: string;
  originalText: string;
  status: 'fixed' | 'removal-failed' | 'transmuter-exhausted' | 'trivially-fixed' | 'resolved-by-prior';
  fixedSource?: string;
  fixDiff?: string;
  exploration?: {
    iterations: number;
    elapsed: number;
    finalScore: number;
    scoreAfterRemoval: number;
    subSession?: SessionReport;
    assemblyDiff?: string;
  };
}

export interface MergeLogEntry {
  step: number;
  violationId: string;
  action: 'skipped-already-resolved' | 'applied-trivially' | 'permuted' | 'failed';
  iterations?: number;
  elapsed?: number;
  sourceAfter?: string;
  diff?: string;
}

export interface RefinementResult {
  source: string;
  violationsFixed: number;
  violationsTotal: number;
  trivialFixes: number;
  permutedFixes: number;
  resolvedByPrior: number;
  notFixable: number;
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Cleanup Report Data
// ---------------------------------------------------------------------------

export interface CleanupReportData {
  sourceBefore: string;
  sourceAfter: string;
  canonicalization: {
    passes: { name: string; applied: number }[];
    totalApplied: number;
  };
  smellPermutation: {
    improved: boolean;
    smellBefore: number;
    smellAfter: number;
    iterations: number;
    elapsed: number;
  } | null;
  smellBefore: SmellBreakdown;
  smellAfter: SmellBreakdown;
  elapsed: number;
}

export interface SmellBreakdown {
  total: number;
  tempVariables: number;
  casts: number;
  doWhileZero: number;
  singleUseVariables: number;
  statementCount: number;
}

// ---------------------------------------------------------------------------
// Union type for report discrimination
// ---------------------------------------------------------------------------

export type Report = SessionReport | RefinementReport;

declare global {
  interface Window {
    __SESSION_REPORT__?: Report;
  }
}
