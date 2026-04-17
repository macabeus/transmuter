/**
 * Bridge between Transmuter core events and CLI state.
 *
 * Maintains a reducer-style state that Ink components can consume.
 */
import type { MutationSearchEvent, MutationTargetSummary } from '@transmuter/core';

export interface CliState {
  phase: 'idle' | 'running' | 'completed';
  baseScore: number;
  bestScore: number;
  iteration: number;
  elapsed: number;
  targets: readonly MutationTargetSummary[];
  candidateCount: number;
  forkCount: number;
  compiled: number;
  errors: number;
  deduped: number;
  lastFork: { ruleId: string; oldScore: number; newScore: number } | null;
  lastAutoCompact: { disabled: number; removed: number } | null;
  completionReason: string | null;
  bestSource: string | null;
  errorMessage: string | null;
  scoreHistory: number[];
}

export function initialState(): CliState {
  return {
    phase: 'idle',
    baseScore: -1,
    bestScore: -1,
    iteration: 0,
    elapsed: 0,
    targets: [],
    candidateCount: 0,
    forkCount: 0,
    compiled: 0,
    errors: 0,
    deduped: 0,
    lastFork: null,
    lastAutoCompact: null,
    completionReason: null,
    bestSource: null,
    errorMessage: null,
    scoreHistory: [],
  };
}

export function reduceEvent(state: CliState, event: MutationSearchEvent): CliState {
  switch (event.type) {
    case 'started':
      return {
        ...state,
        phase: 'running',
        baseScore: event.baseScore,
        bestScore: event.baseScore,
        scoreHistory: [event.baseScore],
      };

    case 'scored':
      return {
        ...state,
        iteration: event.iteration,
        compiled: state.compiled + 1,
      };

    case 'forked':
      return {
        ...state,
        bestScore: Math.min(state.bestScore, event.newScore),
        forkCount: state.forkCount + 1,
        lastFork: {
          ruleId: event.ruleId,
          oldScore: event.oldScore,
          newScore: event.newScore,
        },
        scoreHistory: [...state.scoreHistory, event.newScore].slice(-50),
      };

    case 'compilation-error':
      return {
        ...state,
        errors: state.errors + 1,
      };

    case 'stats':
      return {
        ...state,
        iteration: event.iteration,
        elapsed: event.elapsed,
        targets: event.targets,
        candidateCount: event.candidateCount,
        bestScore: event.bestScore,
      };

    case 'completed':
      return {
        ...state,
        phase: 'completed',
        completionReason: event.reason,
        bestSource: event.bestSource,
        bestScore: event.finalScore,
        iteration: event.totalIterations,
        elapsed: event.elapsed,
      };

    case 'error':
      return {
        ...state,
        errorMessage: event.message,
      };

    case 'perfect-match':
      return {
        ...state,
        bestScore: 0,
        bestSource: event.source,
      };

    case 'auto-compacted':
      return {
        ...state,
        lastAutoCompact: { disabled: event.disabled, removed: event.removed },
      };

    default:
      return state;
  }
}
