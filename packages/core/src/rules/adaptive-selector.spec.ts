import { describe, expect, it } from 'vitest';
import { Rng } from '~/rng.js';

import { AdaptiveSelector } from './adaptive-selector.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Record `count` successes for `goodRule` and `count` failures for `badRule`
 * on a single target. Simulates "overwhelming evidence" for Bayesian tests.
 */
function recordOverwhelming(
  selector: AdaptiveSelector,
  targetId: string,
  goodRule: string,
  badRule: string,
  count = 100,
): void {
  for (let i = 0; i < count; i++) {
    selector.record(targetId, goodRule, true);
    selector.record(targetId, badRule, false);
  }
}

/** Run `trials` selections and return a histogram of picks per rule index. */
function histogramSelections(
  selector: AdaptiveSelector,
  targetId: string,
  eligible: string[],
  rng: Rng,
  trials: number,
): number[] {
  const counts = eligible.map(() => 0);
  for (let i = 0; i < trials; i++) {
    counts[selector.selectIndex(targetId, eligible, rng)]!++;
  }
  return counts;
}

describe('AdaptiveSelector', () => {
  const rules = ['rule-a', 'rule-b', 'rule-c'];

  describe('selectIndex', () => {
    it('returns 0 when only one eligible rule', () => {
      const selector = new AdaptiveSelector();
      const rng = new Rng(7);
      expect(selector.selectIndex('t1', ['only-rule'], rng)).toBe(0);
    });

    it('throws on empty eligible array', () => {
      const selector = new AdaptiveSelector();
      const rng = new Rng(1);
      expect(() => selector.selectIndex('t1', [], rng)).toThrow('empty');
    });

    it('distributes roughly uniformly with no recorded data', () => {
      const selector = new AdaptiveSelector();
      const trials = 3000;
      const counts = histogramSelections(selector, 't1', rules, new Rng(99), trials);

      // Each rule should get roughly 1/3 of selections (within 15 percentage points)
      for (const count of counts) {
        expect(count).toBeGreaterThan(trials / 3 - trials * 0.15);
        expect(count).toBeLessThan(trials / 3 + trials * 0.15);
      }
    });
  });

  describe('record + selectIndex', () => {
    it('favors a rule with many successes over one with many failures', () => {
      const selector = new AdaptiveSelector();
      recordOverwhelming(selector, 't1', 'good-rule', 'bad-rule');

      const trials = 1000;
      const counts = histogramSelections(selector, 't1', ['good-rule', 'bad-rule'], new Rng(42), trials);
      expect(counts[0]).toBeGreaterThan(trials * 0.85);
    });

    it('adapts when a previously bad rule starts succeeding', () => {
      const selector = new AdaptiveSelector({ windowSize: 20 });
      const twoRules = ['rule-a', 'rule-b'];

      // Phase 1: rule-a is terrible, rule-b is great
      recordOverwhelming(selector, 't1', 'rule-b', 'rule-a', 20);
      // Phase 2: rule-a becomes great (fully overwrites the window)
      recordOverwhelming(selector, 't1', 'rule-a', 'rule-b', 20);

      const trials = 1000;
      const counts = histogramSelections(selector, 't1', twoRules, new Rng(55), trials);

      // After the window shift rule-a's posterior is Beta(21, 1) vs rule-b's
      // Beta(1, 21) — overwhelming, so we assert the same 0.85 margin as the
      // "favors a rule" test above.
      expect(counts[0]).toBeGreaterThan(trials * 0.85);
    });

    it('keeps per-target stats isolated during selection', () => {
      const selector = new AdaptiveSelector();
      const twoRules = ['rule-a', 'rule-b'];

      // Target A: rule-a is great, rule-b is terrible.
      // Target B: the opposite.
      // A naive implementation that shared a single stats map across targets
      // would see the records cancel out and fall back to a uniform split.
      recordOverwhelming(selector, 'target-a', 'rule-a', 'rule-b');
      recordOverwhelming(selector, 'target-b', 'rule-b', 'rule-a');

      const rng = new Rng(123);
      const trials = 1000;
      const countsA = histogramSelections(selector, 'target-a', twoRules, rng, trials);
      const countsB = histogramSelections(selector, 'target-b', twoRules, rng, trials);

      // Target A should overwhelmingly prefer rule-a
      expect(countsA[0]).toBeGreaterThan(trials * 0.85);
      // Target B should overwhelmingly prefer rule-b (i.e. rarely pick rule-a)
      expect(countsB[0]).toBeLessThan(trials * 0.15);
    });

    it('does not bias a fresh target based on other targets stats', () => {
      const selector = new AdaptiveSelector();
      const twoRules = ['rule-a', 'rule-b'];

      // Give one target overwhelming evidence that rule-a is the best.
      recordOverwhelming(selector, 'learned', 'rule-a', 'rule-b', 200);

      // A fresh, never-recorded target must start from the uniform prior,
      // not inherit the `learned` target's bias.
      expect(selector.getStats('fresh')).toEqual([]);

      const trials = 3000;
      const counts = histogramSelections(selector, 'fresh', twoRules, new Rng(88), trials);

      // Without bias inheritance, both rules should get roughly half,
      // matching the same margin used by the uniform-prior test above.
      expect(counts[0]).toBeGreaterThan(trials / 2 - trials * 0.15);
      expect(counts[0]).toBeLessThan(trials / 2 + trials * 0.15);
    });
  });

  describe('sliding window', () => {
    it('evicts old data when window is full', () => {
      const selector = new AdaptiveSelector({ windowSize: 5 });

      // Fill window with 5 successes
      for (let i = 0; i < 5; i++) {
        selector.record('t1', 'rule-a', true);
      }

      let stats = selector.getStats('t1');
      expect(stats).toHaveLength(1);
      expect(stats[0]!.trials).toBe(5);
      expect(stats[0]!.successRate).toBe(1);

      // Now push 5 failures — should evict all successes
      for (let i = 0; i < 5; i++) {
        selector.record('t1', 'rule-a', false);
      }

      stats = selector.getStats('t1');
      expect(stats[0]!.trials).toBe(5);
      expect(stats[0]!.successRate).toBe(0);
    });

    it('keeps correct counts during partial eviction', () => {
      const selector = new AdaptiveSelector({ windowSize: 4 });

      // [true, true, false, false]
      selector.record('t1', 'r', true);
      selector.record('t1', 'r', true);
      selector.record('t1', 'r', false);
      selector.record('t1', 'r', false);

      let stats = selector.getStats('t1');
      expect(stats[0]!.trials).toBe(4);
      expect(stats[0]!.successRate).toBe(0.5);

      // Push true — evicts first true: [true, false, false, true]
      selector.record('t1', 'r', true);
      stats = selector.getStats('t1');
      expect(stats[0]!.trials).toBe(4);
      expect(stats[0]!.successRate).toBe(0.5); // 2 successes, 2 failures

      // Push true — evicts second true: [false, false, true, true]
      selector.record('t1', 'r', true);
      stats = selector.getStats('t1');
      expect(stats[0]!.trials).toBe(4);
      expect(stats[0]!.successRate).toBe(0.5); // still 2/4
    });
  });

  describe('fork', () => {
    it('copies parent stats to child', () => {
      const selector = new AdaptiveSelector();
      recordOverwhelming(selector, 'parent', 'rule-a', 'rule-b', 50);

      selector.fork('parent', 'child');

      const parentStats = selector.getStats('parent');
      const childStats = selector.getStats('child');

      expect(childStats).toHaveLength(parentStats.length);
      for (let i = 0; i < parentStats.length; i++) {
        expect(childStats[i]!.ruleId).toBe(parentStats[i]!.ruleId);
        expect(childStats[i]!.trials).toBe(parentStats[i]!.trials);
        expect(childStats[i]!.successRate).toBe(parentStats[i]!.successRate);
      }
    });

    it('child diverges independently from parent', () => {
      const selector = new AdaptiveSelector({ windowSize: 10 });

      for (let i = 0; i < 10; i++) {
        selector.record('parent', 'rule-a', true);
      }

      selector.fork('parent', 'child');

      // Child records all failures — should overwrite inherited successes
      for (let i = 0; i < 10; i++) {
        selector.record('child', 'rule-a', false);
      }

      const parentStats = selector.getStats('parent');
      const childStats = selector.getStats('child');

      expect(parentStats[0]!.successRate).toBe(1);
      expect(childStats[0]!.successRate).toBe(0);
    });

    it('does nothing when parent is unknown', () => {
      const selector = new AdaptiveSelector();
      selector.fork('nonexistent', 'child');
      expect(selector.getStats('child')).toEqual([]);
    });

    it('propagates parent preference to child selectIndex', () => {
      const selector = new AdaptiveSelector();
      const twoRules = ['rule-a', 'rule-b'];

      // Parent strongly prefers rule-a
      recordOverwhelming(selector, 'parent', 'rule-a', 'rule-b');
      selector.fork('parent', 'child');

      // Child should exhibit the same strong preference via selectIndex,
      // proving the Bayesian stats reached the decision layer (not just getStats).
      const trials = 1000;
      const counts = histogramSelections(selector, 'child', twoRules, new Rng(202), trials);
      expect(counts[0]).toBeGreaterThan(trials * 0.85);
    });

    it('overwrites existing stats when forking onto a known target', () => {
      const selector = new AdaptiveSelector();

      // Pre-existing bias on `dest`: rule-b is the winner
      recordOverwhelming(selector, 'dest', 'rule-b', 'rule-a');
      // `src` has the opposite bias
      recordOverwhelming(selector, 'src', 'rule-a', 'rule-b');

      // Forking src → dest should replace dest's stats wholesale
      selector.fork('src', 'dest');

      const destStats = selector.getStats('dest');
      const srcStats = selector.getStats('src');

      expect(destStats).toHaveLength(srcStats.length);
      for (const ruleId of ['rule-a', 'rule-b']) {
        const d = destStats.find((s) => s.ruleId === ruleId)!;
        const s = srcStats.find((s) => s.ruleId === ruleId)!;
        expect(d.trials).toBe(s.trials);
        expect(d.successRate).toBe(s.successRate);
      }
    });
  });

  describe('removeTarget', () => {
    it('frees stats for the target', () => {
      const selector = new AdaptiveSelector();

      selector.record('t1', 'rule-a', true);
      selector.record('t1', 'rule-b', false);
      selector.record('t2', 'rule-a', false);

      expect(selector.getStats('t1')).toHaveLength(2);
      expect(selector.getStats('t2')).toHaveLength(1);

      selector.removeTarget('t1');

      expect(selector.getStats('t1')).toEqual([]);
      expect(selector.getStats('t2')).toHaveLength(1);
    });

    it('does nothing for unknown target', () => {
      const selector = new AdaptiveSelector();
      selector.record('t1', 'rule-a', true);

      selector.removeTarget('nonexistent');

      expect(selector.getStats('t1')).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('returns empty array for unknown target', () => {
      const selector = new AdaptiveSelector();
      expect(selector.getStats('unknown')).toEqual([]);
    });

    it('returns stats for all recorded rules', () => {
      const selector = new AdaptiveSelector();

      selector.record('t1', 'rule-a', true);
      selector.record('t1', 'rule-a', true);
      selector.record('t1', 'rule-a', false);
      selector.record('t1', 'rule-b', false);
      selector.record('t1', 'rule-b', false);

      const stats = selector.getStats('t1');
      expect(stats).toHaveLength(2);

      const ruleA = stats.find((s) => s.ruleId === 'rule-a')!;
      const ruleB = stats.find((s) => s.ruleId === 'rule-b')!;

      expect(ruleA.trials).toBe(3);
      expect(ruleA.successRate).toBeCloseTo(2 / 3);
      expect(ruleB.trials).toBe(2);
      expect(ruleB.successRate).toBe(0);
    });
  });

  describe('serialize / restore', () => {
    it('round-trips an empty selector', () => {
      const a = new AdaptiveSelector({ windowSize: 50 });
      const b = new AdaptiveSelector();
      b.restore(a.serialize());
      expect(b.getStats('anything')).toEqual([]);
    });

    it('round-trips recorded stats', () => {
      const a = new AdaptiveSelector({ windowSize: 20 });
      for (let i = 0; i < 5; i++) {
        a.record('t1', 'rule-a', i % 2 === 0);
      }
      for (let i = 0; i < 3; i++) {
        a.record('t1', 'rule-b', false);
      }
      for (let i = 0; i < 7; i++) {
        a.record('t2', 'rule-a', true);
      }

      const b = new AdaptiveSelector();
      b.restore(a.serialize());

      const t1Stats = b.getStats('t1').sort((x, y) => x.ruleId.localeCompare(y.ruleId));
      expect(t1Stats).toEqual([
        { ruleId: 'rule-a', trials: 5, successRate: 3 / 5 },
        { ruleId: 'rule-b', trials: 3, successRate: 0 },
      ]);
      const t2Stats = b.getStats('t2');
      expect(t2Stats).toEqual([{ ruleId: 'rule-a', trials: 7, successRate: 1 }]);
    });

    it('preserves window eviction state across round-trip', () => {
      const a = new AdaptiveSelector({ windowSize: 3 });
      a.record('t', 'r', false);
      a.record('t', 'r', false);
      a.record('t', 'r', true);
      a.record('t', 'r', true);
      a.record('t', 'r', true);

      const b = new AdaptiveSelector();
      b.restore(a.serialize());

      // Record one more on b: should evict the oldest in-window value (a true).
      b.record('t', 'r', false);
      const statsAfter = b.getStats('t')[0]!;
      expect(statsAfter.trials).toBe(3);
      expect(statsAfter.successRate).toBeCloseTo(2 / 3);
    });

    it('replaces existing state on restore', () => {
      const a = new AdaptiveSelector();
      a.record('t', 'r', true);

      const b = new AdaptiveSelector();
      b.record('other-t', 'other-r', false);
      b.restore(a.serialize());

      expect(b.getStats('other-t')).toEqual([]);
      expect(b.getStats('t')).toHaveLength(1);
    });

    it('rejects an unknown snapshot version', () => {
      const bad = new TextEncoder().encode(JSON.stringify({ version: 99, windowSize: 10, targets: [] }));
      const s = new AdaptiveSelector();
      expect(() => s.restore(bad)).toThrow(/unsupported snapshot version/);
    });
  });
});
