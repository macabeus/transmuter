/**
 * Typed message protocol between the main thread's SlotOrchestrator and each
 * slot worker running the mutate → dedup → compile → score pipeline.
 *
 * Design notes:
 * - Kept in a dedicated file (no runtime imports) so both ends can import just
 *   the types without pulling in the rest of core.
 * - `candidateSource` crosses the boundary via structured clone (fast path for
 *   strings). An ArrayBuffer transferable is accepted only for the optional
 *   `adaptiveSnapshot` field on init and on rebroadcasts.
 * - `WorkerResult.scored` payload is deliberately flat so Main's result handler
 *   can forward most fields straight into a `forked` MutationSearchEvent.
 *
 * See BUN_WORKERS_PLAN.md §4 for the full design rationale.
 */
import type { Language } from '~/language.js';
import type {
  AvoidRegionConstraint,
  DiffBreakdown,
  FocusRegionConstraint,
  MutationLocation,
} from '~/types.js';

/** Worker init message. Sent once, right after construction. */
export interface WorkerInit {
  readonly kind: 'init';
  readonly slotId: number;
  readonly seed: number;
  readonly language: Language;
  readonly functionName: string;
  readonly mutationDepth: number;
  readonly sourcePrefix: string;
  readonly enabledRuleIds: readonly string[];
  readonly ruleWeights: Readonly<Record<string, number>>;
  readonly adaptiveSnapshot: Uint8Array;
  readonly focusRegions: readonly FocusRegionConstraint[];
  readonly avoidRegions: readonly AvoidRegionConstraint[];
  readonly adaptiveSelectorWindowSize: number;
  readonly compiler: {
    readonly command: string;
    readonly cwd: string;
  };
  readonly scorer: {
    readonly targetObjectPath: string;
    readonly diffSettings: Readonly<Record<string, string>>;
  };
}

/** A single mutation job — main assigns one of these per iteration. */
export interface WorkerJob {
  readonly kind: 'job';
  readonly jobId: number;
  readonly mutationTargetId: string;
  readonly candidateSource: string;
  readonly breakdown: DiffBreakdown;
}

/** Control messages: runtime state changes that don't produce a result. */
export type WorkerControl =
  | { readonly kind: 'rules-updated'; readonly enabledRuleIds: readonly string[]; readonly ruleWeights: Readonly<Record<string, number>> }
  | { readonly kind: 'adaptive-snapshot'; readonly snapshot: Uint8Array }
  | {
      readonly kind: 'focus-updated';
      readonly focusRegions: readonly FocusRegionConstraint[];
      readonly avoidRegions: readonly AvoidRegionConstraint[];
    }
  | { readonly kind: 'mutation-depth-updated'; readonly depth: number }
  | { readonly kind: 'shutdown' };

/** Main → worker message envelope. */
export type WorkerInbound = WorkerInit | WorkerJob | WorkerControl;

/** Worker → main result for a WorkerJob. */
export type WorkerResult =
  | {
      readonly kind: 'no-mutation';
      readonly jobId: number;
      readonly mutationTargetId: string;
    }
  | {
      readonly kind: 'dedup';
      readonly jobId: number;
      readonly mutationTargetId: string;
    }
  | {
      readonly kind: 'compile-error';
      readonly jobId: number;
      readonly mutationTargetId: string;
      readonly ruleId: string;
      readonly location: MutationLocation;
      readonly error: string;
      readonly timings: { readonly mutate: number; readonly compile: number };
    }
  | {
      readonly kind: 'scored';
      readonly jobId: number;
      readonly mutationTargetId: string;
      readonly mutatedSource: string;
      readonly ruleId: string;
      readonly location: MutationLocation;
      readonly score: number;
      readonly breakdown: DiffBreakdown;
      readonly assembly: string;
      readonly assemblyDiff: string;
      readonly timings: { readonly mutate: number; readonly compile: number; readonly score: number };
    };

/** Worker → main lifecycle / log events (not tied to a specific job). */
export type WorkerEvent =
  | { readonly kind: 'ready'; readonly slotId: number; readonly initMs: number }
  | {
      readonly kind: 'error';
      readonly slotId: number;
      readonly jobId?: number;
      readonly error: string;
      readonly fatal: boolean;
    };

/** Worker → main message envelope. */
export type WorkerOutbound = WorkerResult | WorkerEvent;
