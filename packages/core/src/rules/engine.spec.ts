import { describe, expect, it } from 'vitest';
import { Rng } from '~/rng.js';
import type { AvoidRegionConstraint, DiffBreakdown, DiffType, MutationApplyResult } from '~/types.js';

import { AdaptiveSelector } from './adaptive-selector.js';
import { MutationEngine, type MutationEngineOptions } from './engine.js';
import { RuleRegistry } from './registry.js';
import type { MutationContext, Rule } from './rule.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a rule that always appends `; // <id>` to the source. */
function fakeRule(id: string, opts?: { languages?: Rule['languages']; relevantDiffTypes?: Set<DiffType> }): Rule {
  return {
    id,
    description: `Fake rule ${id}`,
    languages: opts?.languages ?? ['c'],
    defaultWeight: 10,
    relevantDiffTypes: opts?.relevantDiffTypes,
    apply(ctx: MutationContext): MutationApplyResult | null {
      return {
        source: ctx.source + `\n// ${id}`,
        location: { line: 1, column: 1 },
      };
    },
  };
}

/** Create a rule that always returns null (can't apply). */
function nullRule(id: string): Rule {
  return {
    id,
    description: `Null rule ${id}`,
    languages: ['c'],
    defaultWeight: 10,
    apply(): MutationApplyResult | null {
      return null;
    },
  };
}

/** Create a rule that replaces `AAA` with `BBB`. */
function replaceRule(id: string, from: string, to: string): Rule {
  return {
    id,
    description: `Replace ${from} → ${to}`,
    languages: ['c'],
    defaultWeight: 10,
    apply(ctx: MutationContext): MutationApplyResult | null {
      if (!ctx.source.includes(from)) {
        return null;
      }
      return {
        source: ctx.source.replace(from, to),
        location: { line: 1, column: 1 },
      };
    },
  };
}

/** Create a rule that appends a comment to a specific line (0-indexed). */
function lineModifyRule(id: string, lineIndex: number): Rule {
  return {
    id,
    description: `Modifies line ${lineIndex + 1}`,
    languages: ['c'],
    defaultWeight: 10,
    apply(ctx: MutationContext): MutationApplyResult | null {
      const lines = ctx.source.split('\n');
      if (lineIndex >= lines.length) {
        return null;
      }
      lines[lineIndex] = lines[lineIndex] + ' /* modified */';
      return { source: lines.join('\n'), location: { line: lineIndex + 1, column: 1 } };
    },
  };
}

function makeRegistry(...rules: Rule[]): RuleRegistry {
  const registry = new RuleRegistry();
  registry.registerAll(rules);
  return registry;
}

/**
 * Build an engine with a fresh AdaptiveSelector. Tests rarely care about the selector's state.
 *
 * Uses a seeded `Rng` (not `DeterministicRng`) because Thompson Sampling's Box-Muller
 * step diverges when `float()` always returns 0 — `gammaSample`'s rejection loop never accepts.
 */
function makeEngine(registry: RuleRegistry, options?: Omit<MutationEngineOptions, 'adaptiveSelector'>): MutationEngine {
  return new MutationEngine(registry, new Rng(42), {
    adaptiveSelector: new AdaptiveSelector(),
    ...options,
  });
}

const zeroDiffBreakdown: DiffBreakdown = {
  total: 0,
  insert: 0,
  delete: 0,
  replace: 0,
  opMismatch: 0,
  argMismatch: 0,
};

function avoidRegion(start: number, end: number): AvoidRegionConstraint {
  return { type: 'avoid-region', id: `avoid-${start}-${end}`, description: '', lines: { start, end } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MutationEngine', () => {
  describe('mutate', () => {
    it('applies a single rule and returns the mutated source', () => {
      const engine = makeEngine(makeRegistry(fakeRule('a')));
      const result = engine.mutate('void foo() {}', 'foo', 'test-target');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('void foo() {}\n// a');
      expect(result!.ruleIds).toEqual(['a']);
    });

    it('returns null when no rules are registered', () => {
      const engine = makeEngine(makeRegistry());
      expect(engine.mutate('void foo() {}', 'foo', 'test-target')).toBeNull();
    });

    it('returns null when all rules return null', () => {
      const engine = makeEngine(makeRegistry(nullRule('a'), nullRule('b')));
      expect(engine.mutate('void foo() {}', 'foo', 'test-target')).toBeNull();
    });

    it('returns null when the only rule produces identical source', () => {
      const rule: Rule = {
        id: 'identity',
        description: 'Returns source unchanged',
        languages: ['c'],
        defaultWeight: 10,
        apply(ctx) {
          return { source: ctx.source, location: { line: 1, column: 1 } };
        },
      };
      const engine = makeEngine(makeRegistry(rule));
      expect(engine.mutate('void foo() {}', 'foo', 'test-target')).toBeNull();
    });
  });

  describe('depth chaining', () => {
    it('chains multiple mutations at depth > 1', () => {
      const engine = makeEngine(makeRegistry(fakeRule('a')));
      const result = engine.mutate('void foo() {}', 'foo', 'test-target', 2);
      expect(result).not.toBeNull();
      expect(result!.source).toBe('void foo() {}\n// a\n// a');
      expect(result!.ruleIds).toEqual(['a', 'a']);
    });

    it('returns partial result when second depth level cannot apply', () => {
      const engine = makeEngine(makeRegistry(replaceRule('ab', 'A', 'B')));
      const result = engine.mutate('void foo() { A; }', 'foo', 'test-target', 3);
      expect(result).not.toBeNull();
      expect(result!.source).toBe('void foo() { B; }');
      expect(result!.ruleIds).toEqual(['ab']);
    });

    it('returns null when first depth level fails', () => {
      const engine = makeEngine(makeRegistry(nullRule('noop')));
      expect(engine.mutate('void foo() {}', 'foo', 'test-target', 3)).toBeNull();
    });
  });

  describe('diff-type filtering', () => {
    it('excludes rules whose relevantDiffTypes do not match the breakdown', () => {
      const insertOnly = fakeRule('insert-rule', {
        relevantDiffTypes: new Set<DiffType>(['insert']),
      });
      const engine = makeEngine(makeRegistry(insertOnly));

      const noInsertBreakdown: DiffBreakdown = { ...zeroDiffBreakdown, argMismatch: 5 };
      expect(engine.mutate('void foo() {}', 'foo', 'test-target', 1, noInsertBreakdown)).toBeNull();
    });

    it('includes rules whose relevantDiffTypes match the breakdown', () => {
      const insertOnly = fakeRule('insert-rule', {
        relevantDiffTypes: new Set<DiffType>(['insert']),
      });
      const engine = makeEngine(makeRegistry(insertOnly));

      const hasInsert: DiffBreakdown = { ...zeroDiffBreakdown, insert: 3 };
      const result = engine.mutate('void foo() {}', 'foo', 'test-target', 1, hasInsert);
      expect(result).not.toBeNull();
      expect(result!.ruleIds).toEqual(['insert-rule']);
    });

    it('always includes rules without relevantDiffTypes', () => {
      const universal = fakeRule('universal');
      const engine = makeEngine(makeRegistry(universal));

      const result = engine.mutate('void foo() {}', 'foo', 'test-target', 1, zeroDiffBreakdown);
      expect(result).not.toBeNull();
    });
  });

  describe('language filtering', () => {
    it('excludes rules for a different language', () => {
      const pascalOnly = fakeRule('pascal-rule', { languages: ['pascal'] });
      const engine = makeEngine(makeRegistry(pascalOnly), { language: 'c' });
      expect(engine.mutate('void foo() {}', 'foo', 'test-target')).toBeNull();
    });

    it('includes rules matching the engine language', () => {
      const cRule = fakeRule('c-rule', { languages: ['c'] });
      const engine = makeEngine(makeRegistry(cRule), { language: 'c' });
      const result = engine.mutate('void foo() {}', 'foo', 'test-target');
      expect(result).not.toBeNull();
    });
  });

  describe('avoid regions', () => {
    it('rejects mutations that modify a protected line', () => {
      const engine = makeEngine(makeRegistry(lineModifyRule('modify-line2', 1)), {
        avoidRegions: [avoidRegion(2, 2)],
      });
      expect(engine.mutate('void foo() {\n  int a = 1;\n}', 'foo', 'test-target')).toBeNull();
    });

    it('allows mutations outside the protected region', () => {
      const engine = makeEngine(makeRegistry(lineModifyRule('modify-line1', 0)), {
        avoidRegions: [avoidRegion(2, 2)],
      });
      const result = engine.mutate('void foo() {\n  int a = 1;\n}', 'foo', 'test-target');
      expect(result).not.toBeNull();
      expect(result!.source).toContain('/* modified */');
    });
  });

  describe('setFocusConstraints', () => {
    it('updates avoid regions dynamically', () => {
      const engine = makeEngine(makeRegistry(lineModifyRule('modify-line2', 1)));

      // No constraints — mutation succeeds
      const result1 = engine.mutate('void foo() {\n  int a = 1;\n}', 'foo', 'test-target');
      expect(result1).not.toBeNull();

      // Add avoid region — mutation rejected
      engine.setFocusConstraints([], [avoidRegion(2, 2)]);
      const result2 = engine.mutate('void foo() {\n  int a = 1;\n}', 'foo', 'test-target');
      expect(result2).toBeNull();

      // Remove constraints — mutation succeeds again
      engine.setFocusConstraints([], []);
      const result3 = engine.mutate('void foo() {\n  int a = 1;\n}', 'foo', 'test-target');
      expect(result3).not.toBeNull();
    });
  });

  describe('weighted selection', () => {
    it('respects rule weights from the registry', () => {
      const heavy = fakeRule('heavy');
      const zero = fakeRule('zero');
      const registry = makeRegistry(heavy, zero);
      registry.setWeight('heavy', 100);
      registry.setWeight('zero', 0);

      const engine = new MutationEngine(registry, new Rng(0), { adaptiveSelector: new AdaptiveSelector() });
      // With zero weight disabled, only 'heavy' can fire
      const result = engine.mutate('void foo() {}', 'foo', 'test-target');
      expect(result).not.toBeNull();
      expect(result!.ruleIds).toEqual(['heavy']);
    });
  });

  describe('MAX_ATTEMPTS', () => {
    it('blacklists rules that return null within a single mutate() call', () => {
      // When a rule returns null, the engine treats that as a deterministic
      // "no candidates in this AST" signal and drops the rule from the
      // candidate pool — so the same null-returning rule is never re-queried
      // in the same call. This is the dedup optimization (PERFORMANCE #2).
      let attempts = 0;
      const countingNull: Rule = {
        id: 'counting-null',
        description: 'Counts attempts then returns null',
        languages: ['c'],
        defaultWeight: 10,
        apply() {
          attempts++;
          return null;
        },
      };
      const engine = makeEngine(makeRegistry(countingNull));
      expect(engine.mutate('void foo() {}', 'foo', 'test-target')).toBeNull();
      expect(attempts).toBe(1);
    });

    it('retries MAX_ATTEMPTS times when a rule returns a no-op (source unchanged)', () => {
      // A no-op result (result.source === source) is treated as RNG-dependent —
      // the rule still has candidates, just picked a non-mutating one. So it
      // stays in the pool and can be re-picked up to MAX_ATTEMPTS times.
      let attempts = 0;
      const noopRule: Rule = {
        id: 'noop-rule',
        description: 'Returns the source unchanged',
        languages: ['c'],
        defaultWeight: 10,
        apply(ctx) {
          attempts++;
          return { source: ctx.source, location: { line: 1, column: 1 } };
        },
      };
      const engine = makeEngine(makeRegistry(noopRule));
      expect(engine.mutate('void foo() {}', 'foo', 'test-target')).toBeNull();
      expect(attempts).toBe(10);
    });
  });
});
