/**
 * Per-target adaptive rule selection using Thompson Sampling.
 *
 * Each mutation target maintains its own Beta distribution per rule.
 * On each selection, samples from Beta(a, b) for eligible rules and picks
 * the highest sample. A sliding window ensures stale data ages out as the
 * search landscape changes.
 */
import type { Rng } from '~/rng.js';
import type { AdaptiveSelectorOptions } from '~/types.js';
import { CircularBuffer } from '~/utils/circular-buffer.js';

export type { AdaptiveSelectorOptions };

export interface RuleStats {
  ruleId: string;
  trials: number;
  successRate: number;
}

// ---------------------------------------------------------------------------
// Per-rule stats for a single target
// ---------------------------------------------------------------------------

interface RuleRecord {
  successes: number;
  failures: number;
  window: CircularBuffer<boolean>;
}

interface AdaptiveSnapshotRule {
  id: string;
  successes: number;
  failures: number;
  window: { capacity: number; head: number; size: number; values: boolean[] };
}

interface AdaptiveSnapshotV1 {
  version: 1;
  windowSize: number;
  targets: { id: string; rules: AdaptiveSnapshotRule[] }[];
}

function cloneRuleRecord(r: RuleRecord): RuleRecord {
  return {
    successes: r.successes,
    failures: r.failures,
    window: r.window.clone(),
  };
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

/**
 * Sample from a standard normal distribution using the Box-Muller transform.
 */
function normalSample(rng: Rng): number {
  const u1 = rng.float();
  const u2 = rng.float();
  return Math.sqrt(-2 * Math.log(u1 || Number.MIN_VALUE)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample from Gamma(alpha, 1) using Marsaglia & Tsang's method.
 * Requires alpha > 0.
 */
function gammaSample(alpha: number, rng: Rng): number {
  if (alpha < 1) {
    // Gamma(alpha, 1) = Gamma(alpha + 1, 1) * U^(1/alpha)
    return gammaSample(alpha + 1, rng) * Math.pow(rng.float() || Number.MIN_VALUE, 1 / alpha);
  }

  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalSample(rng);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = rng.float();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }
    if (Math.log(u || Number.MIN_VALUE) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/**
 * Sample from Beta(alpha, beta) via the Gamma trick.
 */
function betaSample(alpha: number, beta: number, rng: Rng): number {
  const x = gammaSample(alpha, rng);
  const y = gammaSample(beta, rng);
  return x / (x + y);
}

// ---------------------------------------------------------------------------
// AdaptiveSelector
// ---------------------------------------------------------------------------

export class AdaptiveSelector {
  #windowSize: number;
  /** targetId -> (ruleId -> RuleRecord) */
  #targets = new Map<string, Map<string, RuleRecord>>();

  constructor(options?: AdaptiveSelectorOptions) {
    this.#windowSize = options?.windowSize ?? 500;
  }

  /**
   * Select the index of the best eligible rule for the given target
   * using Thompson Sampling (Beta posterior sampling).
   *
   * @param targetId   Unique identifier of the mutation target
   * @param eligible   Array of rule IDs that are eligible for selection
   * @param rng        Seeded PRNG instance
   * @returns          Index into `eligible` of the selected rule
   */
  selectIndex(targetId: string, eligible: readonly string[], rng: Rng): number {
    if (eligible.length === 0) {
      throw new Error('AdaptiveSelector.selectIndex: eligible array is empty');
    }

    if (eligible.length === 1) {
      return 0;
    }

    const targetStats = this.#targets.get(targetId);
    let bestIndex = 0;
    let bestSample = -Infinity;

    for (let i = 0; i < eligible.length; i++) {
      const ruleId = eligible[i]!;
      const record = targetStats?.get(ruleId);

      const alpha = (record?.successes ?? 0) + 1;
      const beta = (record?.failures ?? 0) + 1;

      const sample = betaSample(alpha, beta, rng);
      if (sample > bestSample) {
        bestSample = sample;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  /**
   * Record the outcome of applying a rule to a target.
   *
   * @param targetId  Target identifier
   * @param ruleId    Rule that was applied
   * @param forked    Whether the outcome was a fork (success)
   */
  record(targetId: string, ruleId: string, forked: boolean): void {
    let targetStats = this.#targets.get(targetId);
    if (!targetStats) {
      targetStats = new Map();
      this.#targets.set(targetId, targetStats);
    }

    let record = targetStats.get(ruleId);
    if (!record) {
      record = {
        successes: 0,
        failures: 0,
        window: new CircularBuffer<boolean>(this.#windowSize),
      };
      targetStats.set(ruleId, record);
    }

    const evicted = record.window.push(forked);

    // Decrement the counter for the evicted value (if buffer was full)
    if (evicted !== undefined) {
      if (evicted) {
        record.successes--;
      } else {
        record.failures--;
      }
    }

    // Increment the counter for the new value
    if (forked) {
      record.successes++;
    } else {
      record.failures++;
    }
  }

  /**
   * Fork (deep copy) the parent target's stats to a new target ID.
   * The child starts with inherited knowledge and diverges independently.
   *
   * @param parentTargetId  Source target whose stats to copy
   * @param newTargetId     Destination target ID
   */
  fork(parentTargetId: string, newTargetId: string): void {
    const parentStats = this.#targets.get(parentTargetId);
    if (!parentStats) {
      return; // Nothing to copy — child starts fresh
    }

    const childStats = new Map<string, RuleRecord>();
    for (const [ruleId, record] of parentStats) {
      childStats.set(ruleId, cloneRuleRecord(record));
    }
    this.#targets.set(newTargetId, childStats);
  }

  /**
   * Remove all stats for a target, freeing the associated memory.
   * Used during graph summarization (compaction).
   */
  removeTarget(targetId: string): void {
    this.#targets.delete(targetId);
  }

  /**
   * Serialize the entire Thompson Sampling state as a transferable byte buffer.
   * Intended for shipping stats to worker threads at init time or on periodic
   * rebroadcast. The bytes are JSON-encoded UTF-8; simplicity over compactness.
   * Size scales with active rules × targets × windowSize (boolean arrays
   * dominate); sent infrequently via SlotOrchestrator's iteration-counted
   * rebroadcast, so cost is bounded by rebroadcast frequency, not iteration rate.
   */
  serialize(): Uint8Array {
    const snapshot: AdaptiveSnapshotV1 = {
      version: 1,
      windowSize: this.#windowSize,
      targets: [],
    };
    for (const [targetId, rules] of this.#targets) {
      const ruleEntries: AdaptiveSnapshotRule[] = [];
      for (const [ruleId, record] of rules) {
        ruleEntries.push({
          id: ruleId,
          successes: record.successes,
          failures: record.failures,
          window: record.window.toSnapshot(),
        });
      }
      snapshot.targets.push({ id: targetId, rules: ruleEntries });
    }
    return new TextEncoder().encode(JSON.stringify(snapshot));
  }

  /**
   * Replace the selector's state with the contents of a snapshot produced by
   * `serialize()`. Invalid payloads throw.
   */
  restore(bytes: Uint8Array): void {
    const decoded = new TextDecoder().decode(bytes);
    const snapshot = JSON.parse(decoded) as AdaptiveSnapshotV1;
    if (snapshot.version !== 1) {
      throw new Error(`AdaptiveSelector.restore: unsupported snapshot version ${snapshot.version}`);
    }
    this.#windowSize = snapshot.windowSize;
    this.#targets = new Map();
    for (const target of snapshot.targets) {
      const rules = new Map<string, RuleRecord>();
      for (const rule of target.rules) {
        rules.set(rule.id, {
          successes: rule.successes,
          failures: rule.failures,
          window: CircularBuffer.fromSnapshot<boolean>(rule.window),
        });
      }
      this.#targets.set(target.id, rules);
    }
  }

  /**
   * Return interpretable stats for every rule observed under the given target.
   *
   * @param targetId  Target identifier
   * @returns         Array of per-rule stats, or empty array if target is unknown
   */
  getStats(targetId: string): RuleStats[] {
    const targetStats = this.#targets.get(targetId);
    if (!targetStats) {
      return [];
    }

    const result: RuleStats[] = [];
    for (const [ruleId, record] of targetStats) {
      const trials = record.successes + record.failures;
      result.push({
        ruleId,
        trials,
        successRate: trials > 0 ? record.successes / trials : 0,
      });
    }
    return result;
  }
}
