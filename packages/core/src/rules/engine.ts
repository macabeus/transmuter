/**
 * Mutation engine — selects and applies rules to produce mutated candidates.
 */
import type { Language } from '~/language.js';
import { parseCached } from '~/parser.js';
import type { Rng } from '~/rng.js';
import { CompositeNodeFilter } from '~/rules/node-filter.js';
import type {
  AvoidRegionConstraint,
  DiffBreakdown,
  FocusRegionConstraint,
  MutationLocation,
  MutationResult,
} from '~/types.js';

import type { AdaptiveSelector } from './adaptive-selector.js';
import type { RuleRegistry } from './registry.js';
import type { MutationContext, NodeFilter } from './rule.js';

/** Maximum attempts to find an applicable rule before giving up. */
const MAX_ATTEMPTS = 10;

const PROFILE = !!process.env.TRANSMUTER_PROFILE;
export const PROFILE_STATS = { parseNs: 0, ruleApplyNs: 0 };

export interface MutationEngineOptions {
  adaptiveSelector: AdaptiveSelector;
  language?: Language;
  nodeFilter?: NodeFilter;
  avoidRegions?: AvoidRegionConstraint[];
}

export class MutationEngine {
  #registry: RuleRegistry;
  #rng: Rng;
  #language: Language;
  #nodeFilter?: NodeFilter;
  #avoidRegions: AvoidRegionConstraint[];
  #adaptiveSelector: AdaptiveSelector;

  constructor(registry: RuleRegistry, rng: Rng, options: MutationEngineOptions) {
    this.#registry = registry;
    this.#rng = rng;
    this.#language = options.language ?? 'c';
    this.#nodeFilter = options.nodeFilter;
    this.#avoidRegions = options.avoidRegions ?? [];
    this.#adaptiveSelector = options.adaptiveSelector;
  }

  /** Replace focus and avoid region constraints. Takes effect on the next mutate() call. */
  setFocusConstraints(focusRegions: FocusRegionConstraint[], avoidRegions: AvoidRegionConstraint[]): void {
    this.#avoidRegions = avoidRegions;
    this.#nodeFilter =
      focusRegions.length > 0 || avoidRegions.length > 0
        ? new CompositeNodeFilter(focusRegions, avoidRegions)
        : undefined;
  }

  /**
   * Apply random mutation(s) to the source.
   *
   * @param source - Source code
   * @param functionName - Target function name
   * @param targetId - Mutation target ID, used as the key for adaptive rule selection
   * @param depth - Number of mutations to chain (default: 1)
   * @returns Mutated source, rule IDs, and location, or null if no rule could apply
   */
  mutate(
    source: string,
    functionName: string,
    targetId: string,
    depth: number = 1,
    breakdown?: DiffBreakdown,
  ): MutationResult | null {
    let currentSource = source;
    const appliedRuleIds: string[] = [];
    let lastLocation: MutationLocation = { line: 0, column: 0 };

    for (let d = 0; d < depth; d++) {
      const result = this.#applyOne(currentSource, functionName, targetId, breakdown);
      if (!result) {
        // If no rule applied at any depth level, return null only if first level
        if (d === 0) {
          return null;
        }
        break;
      }
      currentSource = result.source;
      appliedRuleIds.push(result.ruleId);
      lastLocation = result.location;
    }

    if (appliedRuleIds.length === 0) {
      return null;
    }

    return { source: currentSource, ruleIds: appliedRuleIds, location: lastLocation };
  }

  /**
   * Apply a single random rule to the source.
   * Tries up to MAX_ATTEMPTS rules before giving up.
   * If the mutation touches an avoid region, it is rejected and retried.
   */
  #applyOne(
    source: string,
    functionName: string,
    targetId: string,
    breakdown?: DiffBreakdown,
  ): { source: string; ruleId: string; location: MutationLocation } | null {
    let active = this.#registry.getActiveRules(this.#language);
    if (active.length === 0) {
      return null;
    }

    if (breakdown) {
      active = active.filter(({ rule }) => {
        if (!rule.relevantDiffTypes) {
          return true;
        }
        for (const diffType of rule.relevantDiffTypes) {
          if (breakdown[diffType] > 0) {
            return true;
          }
        }
        return false;
      });
    }

    if (active.length === 0) {
      return null;
    }

    const t0 = PROFILE ? process.hrtime.bigint() : 0n;
    const root = parseCached(this.#language, source);
    if (PROFILE) {
      PROFILE_STATS.parseNs += Number(process.hrtime.bigint() - t0);
    }

    const ctx: MutationContext = {
      source,
      root,
      rng: this.#rng,
      functionName,
      language: this.#language,
      nodeFilter: this.#nodeFilter,
    };

    // Track rules that hard-failed (returned null) this call. Such failures
    // are deterministic given the source — the rule found no candidates in
    // this AST, so re-picking it within the same #applyOne would run the
    // same lookup again. Drop it from the candidate pool.
    let candidates = active;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (candidates.length === 0) {
        break;
      }

      const index = this.#adaptiveSelector.selectIndex(
        targetId,
        candidates.map((r) => r.rule.id),
        this.#rng,
      );
      const { rule } = candidates[index]!;

      const tRule = PROFILE ? process.hrtime.bigint() : 0n;
      const result = rule.apply(ctx);
      if (PROFILE) {
        PROFILE_STATS.ruleApplyNs += Number(process.hrtime.bigint() - tRule);
      }

      if (result === null) {
        // Hard fail — no candidates in this AST. Skip on future attempts.
        candidates = candidates.filter((_, i) => i !== index);
        continue;
      }
      if (result.source === source) {
        // Rule made a no-op change (e.g., commutative swap on equal operands)
        // — could succeed under a different RNG roll, so keep it in the pool.
        continue;
      }
      if (this.#touchesAvoidRegion(source, result.source)) {
        continue;
      }
      return { source: result.source, ruleId: rule.id, location: result.location };
    }

    return null;
  }

  /**
   * Check if a mutation changed any lines within an avoid region.
   * Compares the source lines before and after the mutation.
   */
  #touchesAvoidRegion(original: string, mutated: string): boolean {
    if (this.#avoidRegions.length === 0) {
      return false;
    }

    const origLines = original.split('\n');
    const mutLines = mutated.split('\n');

    for (const region of this.#avoidRegions) {
      // 1-indexed to 0-indexed
      const start = region.lines.start - 1;
      const end = region.lines.end; // exclusive in slice, but region.end is inclusive

      // If line counts differ and the region is within range, consider it touched
      if (origLines.length !== mutLines.length) {
        // Line count changed — can't do line-by-line comparison of the protected region.
        // Conservative check: if the mutation changed the total line count,
        // only reject if lines BEFORE the region changed in a way that would shift it.
        // For simplicity, reject if region falls within affected range.
        if (start < Math.max(origLines.length, mutLines.length)) {
          // Check if any protected line content differs
          for (let i = start; i < end && i < origLines.length && i < mutLines.length; i++) {
            if (origLines[i] !== mutLines[i]) {
              return true;
            }
          }
          // If line count changed and region extends beyond one of the arrays, it's touched
          if (end > origLines.length || end > mutLines.length) {
            return true;
          }
        }
        continue;
      }

      // Same line count — simple comparison
      for (let i = start; i < end && i < origLines.length; i++) {
        if (origLines[i] !== mutLines[i]) {
          return true;
        }
      }
    }

    return false;
  }
}
