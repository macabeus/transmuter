/**
 * Typed message protocol between the main thread's SlotOrchestrator and each
 * slot worker running the mutate → dedup → compile → score pipeline.
 *
 * Types-only so both ends can import the protocol without pulling in the rest
 * of core (workers stay light on init).
 */
import type { Language } from '~/language.js';
import type { AvoidRegionConstraint, DiffBreakdown, FocusRegionConstraint, MutationLocation } from '~/types.js';

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
  | {
      readonly kind: 'rules-updated';
      readonly enabledRuleIds: readonly string[];
      readonly ruleWeights: Readonly<Record<string, number>>;
    }
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

/**
 * Per-job phase timings (milliseconds). Always populated for every phase the
 * job actually reached. `parse` and `ruleApply` are sub-phases of `mutate` and
 * are only non-zero when `TRANSMUTER_PROFILE=1` (engine instrumentation is
 * env-gated to avoid hot-path overhead). The orchestrator sums these across
 * all workers for the Permuter-style profile breakdown.
 */
export interface PhaseTimings {
  readonly mutate: number;
  readonly parse: number;
  readonly ruleApply: number;
  readonly dedup?: number;
  readonly compile?: number;
  readonly score?: number;
}

/** Worker → main result for a WorkerJob. */
export type WorkerResult =
  | {
      readonly kind: 'no-mutation';
      readonly jobId: number;
      readonly timings: PhaseTimings;
    }
  | {
      readonly kind: 'dedup';
      readonly jobId: number;
      readonly timings: PhaseTimings;
    }
  | {
      readonly kind: 'compile-error';
      readonly jobId: number;
      readonly mutationTargetId: string;
      readonly ruleId: string;
      readonly error: string;
      readonly timings: PhaseTimings;
    }
  | {
      /**
       * Compile succeeded but the scorer couldn't read the function symbol
       * from the resulting .o (e.g. compiler optimised it away or renamed
       * it). The mutation is unusable, but this is NOT a compile failure —
       * the orchestrator must not lump this with compile-error stats or
       * call `pool.recordFailure()` for this kind.
       */
      readonly kind: 'scorer-failed';
      readonly jobId: number;
      readonly mutationTargetId: string;
      readonly ruleId: string;
      readonly error: string;
      readonly timings: PhaseTimings;
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
      readonly timings: PhaseTimings;
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
