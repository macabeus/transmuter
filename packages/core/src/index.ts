/**
 * @transmuter/core — public API
 */

// Language
export type { Language } from './language.js';
export { detectLanguage } from './language.js';
export { ensureLanguageRegistered } from './parser.js';

// Main class
export { MutationSearch, defaultConcurrency } from './search/mutation-search.js';
export type { SummarizeResult } from './pipeline/pool.js';

// Session store
export { SessionStore } from './session/store.js';
export { CompositeNodeFilter } from './rules/node-filter.js';
export { computeCollapsedGraph } from './session/collapsed-graph.js';

// Types
export type {
  // Language (re-export from types for convenience)
  Language as LanguageType,
  // Scoring
  DiffType,
  DiffBreakdown,
  AssemblyScoreResult,
  StructuredDifference,
  // Candidate Graph
  CandidateNode,
  SuperNode,
  MutationTarget,
  MutationTargetSummary,
  PoolStats,
  // Mutation
  MutationLocation,
  MutationApplyResult,
  MutationResult,
  MutationReport,
  // Options & Result
  AutoCompactPolicy,
  MutationSearchEvent,
  MutationSearchEventHandler,
  MutationSearchOptions,
  MutationSearchResult,
  MutationSearchState,
  // Focus constraints
  FocusConstraint,
  FocusRegionConstraint,
  AvoidRegionConstraint,
  HypothesisConstraint,
  // Session report
  CollapsedGraph,
  SpineNode,
  ClusterSummary,
  SessionReport,
  SessionMetadata,
  SessionConfig,
  SessionSummary,
  RuleStatsEntry,
  TimelinePoint,
  FocusResult,
  SessionStoreOptions,
  // Reducer
  ReducerOptions,
  ReducerResult,
  // Cleanup report
  CleanupReportData,
  // Refinement
  Report,
  RefinementReport,
  RefinementConfig,
  ViolationReport,
  MergeLogEntry,
  PendingMerge,
  RefinementResult,
  RefinerEvent,
  RefinerEventHandler,
  RefinerOptions,
  ViolationHypothesis,
} from './types.js';

// Rule system
export type { Rule, MutationContext, NodeFilter } from './rules/rule.js';
export { RuleRegistry } from './rules/registry.js';
export { MutationEngine } from './rules/engine.js';
export { builtInRules } from './rules/built-in/index.js';
export { AdaptiveSelector } from './rules/adaptive-selector.js';
export type { AdaptiveSelectorOptions } from './rules/adaptive-selector.js';
export type { ResolvedRule, GetRuleWeightsOptions } from './rules/get-rule-weights.js';
export { getRuleWeights } from './rules/get-rule-weights.js';

// Guideline system
export type { Guideline, Violation } from './guidelines/guideline.js';
export { GuidelineRegistry } from './guidelines/registry.js';
export { builtInGuidelines } from './guidelines/built-in/index.js';
export { noAsmPin, noGoto, noCStyleCast, noRedundantCastPascal } from './guidelines/built-in/index.js';

// Refiner
export { Refiner, type ActiveSubSession } from './refiner/refiner.js';
export { RefinementStore } from './refiner/refiner-store.js';

// Profiles
export type { Profile } from './profiles/profile.js';
export type { ProfileTrace, GetProfileOptions } from './profiles/get-profile.js';
export { getProfile } from './profiles/get-profile.js';

// Cleanup
export { Cleanup } from './cleanup/cleanup.js';
export type {
  CleanupOptions,
  CleanupResult,
  CleanupEvent,
  CleanupEventHandler,
  SmellPermutationResult,
} from './cleanup/cleanup.js';
export { Canonicalizer } from './cleanup/canonicalizer.js';
export type { CanonicalizerOptions, CanonicalizerResult } from './cleanup/canonicalizer.js';
export { countSmells } from './cleanup/smell.js';
export type { SmellBreakdown } from './cleanup/smell.js';

// Reducer
export { Reducer } from './reducer/reducer.js';

// Isolate
export { isolateFunction } from './isolate/isolate.js';
export type { IsolateResult } from './isolate/isolate.js';
export { extractFunctionDefinition } from './isolate/extract-function.js';

// Scoring (for advanced consumers)
export { Scorer } from './scoring/scorer.js';
export { Objdiff } from './scoring/objdiff.js';

// Compiler (for advanced consumers)
export { Compiler } from './compiler/compiler.js';

// RNG (for testing / deterministic reproduction)
export { Rng } from './rng.js';
