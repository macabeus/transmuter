import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionConfig } from '~/types.js';

import { SessionStore } from './store.js';

function makeConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    functionName: 'test_func',
    targetObjectPath: '/tmp/target.o',
    compilerCommand: 'gcc {{inputPath}} -o {{outputPath}}',
    language: 'c',
    concurrency: 2,
    maxCompiles: 1000,
    timeoutMs: 60000,
    seed: 42,
    mutationDepth: 1,
    lateralForkBudget: 0,
    ruleWeights: {},
    disabledRules: [],
    focusConstraints: [],
    ...overrides,
  };
}

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ metadata: { sessionId: 'test-session', label: 'test' } });
    store.setConfig(makeConfig());
    store.setOriginalSource('void test_func() { int a = 1; }');
  });

  describe('event processing', () => {
    it('processes started event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });

      const summary = store.getSummary();
      expect(summary.baseScore).toBe(100);
      expect(summary.bestScore).toBe(100);
    });

    it('processes scored event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({ type: 'scored', iteration: 1, score: 95, ruleId: 'reorder-stmts', mutationTargetId: 'mt-0' });

      const summary = store.getSummary();
      expect(summary.totalCompiled).toBe(1);
      expect(summary.totalIterations).toBe(1);
    });

    it('processes forked event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({
        type: 'forked',
        iteration: 1,
        parentCandidateId: 'genesis',
        candidateId: 'c-1',
        mutationTargetId: 'mt-0',
        oldScore: 100,
        newScore: 90,
        source: 'void test_func() { int a = 2; }',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: 'mov r0, #2',
        assemblyDiff: '',
        breakdown: { total: 0, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });

      const summary = store.getSummary();
      expect(summary.bestScore).toBe(90);
      expect(summary.forkCount).toBe(1);
      expect(summary.scoreDelta).toBe(10);
    });

    it('processes compilation-error event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({ type: 'compilation-error', mutationTargetId: 'mt-0', ruleId: 'cast-expr', error: 'syntax error' });

      const summary = store.getSummary();
      expect(summary.totalErrors).toBe(1);
    });

    it('processes stats event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'stats',
        iteration: 100,
        elapsed: 5000,
        targets: [{ id: 'mt-0', candidateId: 'genesis', score: 90, weight: 1, attempts: 100, enabled: true }],
        bestScore: 90,
        candidateCount: 5,
        compiled: 80,
        errors: 15,
        deduped: 5,
        rulesUsed: { 'reorder-stmts': 50 },
      });

      // The timeline is anchored at (0, baseScore) by the 'started' event,
      // with the stats tick appended afterwards.
      const timeline = store.getScoreTimeline();
      expect(timeline).toHaveLength(2);
      expect(timeline[0]!.iteration).toBe(0);
      expect(timeline[0]!.bestScore).toBe(100);
      expect(timeline[1]!.bestScore).toBe(90);
      expect(timeline[1]!.iteration).toBe(100);
    });

    it('processes completed event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'completed',
        reason: 'timeout',
        finalScore: 50,
        totalIterations: 5000,
        elapsed: 60000,
        bestSource: 'void test_func() { int a = 3; }',
      });

      const summary = store.getSummary();
      expect(summary.completionReason).toBe('timeout');
      expect(summary.bestScore).toBe(50);
    });

    it('processes perfect-match event', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({ type: 'perfect-match', iteration: 42, source: 'perfect code', candidateId: 'c-0' });

      const summary = store.getSummary();
      expect(summary.bestScore).toBe(0);
      expect(summary.perfectMatch).toBe(true);
    });

    it('processes mutation-target-created event', () => {
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-1',
        candidateId: 'c-1',
        score: 80,
        origin: 'external',
      });

      const graph = store.getGraph();
      expect(graph.mutationTargets).toHaveLength(2);
      expect(graph.mutationTargets[0]!.enabled).toBe(true);
    });

    it('stores injected candidate source from event, not originalSource', () => {
      const injectedSource = 'void test_func() { int injected = 42; }';

      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-1',
        candidateId: 'c-ext',
        score: 50,
        origin: 'external',
        source: injectedSource,
      });

      const candidate = store.getCandidate('c-ext');
      expect(candidate).toBeDefined();
      // The stored source must be the injected source, NOT the originalSource
      expect(candidate!.source).toBe(injectedSource);
    });

    it('processes mutation-target-disabled event', () => {
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({ type: 'mutation-target-disabled', mutationTargetId: 'mt-0' });

      const graph = store.getGraph();
      expect(graph.mutationTargets[0]!.enabled).toBe(false);
    });

    it('processes mutation-target-enabled event (re-enables a disabled target)', () => {
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({ type: 'mutation-target-disabled', mutationTargetId: 'mt-0' });
      expect(store.getGraph().mutationTargets[0]!.enabled).toBe(false);

      store.push({ type: 'mutation-target-enabled', mutationTargetId: 'mt-0' });
      expect(store.getGraph().mutationTargets[0]!.enabled).toBe(true);
      expect(store.getSummary().activeTargetCount).toBe(1);
    });

    it('processes mutation-target-weight-changed event', () => {
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      expect(store.getGraph().mutationTargets[0]!.weight).toBe(1);

      store.push({ type: 'mutation-target-weight-changed', mutationTargetId: 'mt-0', weight: 3.5 });
      expect(store.getGraph().mutationTargets[0]!.weight).toBe(3.5);
    });

    it('scored event bumps target attempts', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({ type: 'scored', iteration: 1, score: 95, ruleId: 'reorder-stmts', mutationTargetId: 'mt-0' });
      store.push({ type: 'scored', iteration: 2, score: 92, ruleId: 'reorder-stmts', mutationTargetId: 'mt-0' });

      const target = store.getGraph().mutationTargets[0]!;
      expect(target.attempts).toBe(2);
      expect(target.attemptsWithoutFork).toBe(2);
    });

    it('scored event does not change bestScore when no fork occurs', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      // A scored event with a lower score alone does NOT update best — only
      // a successful fork does. This test locks in that invariant.
      store.push({ type: 'scored', iteration: 1, score: 20, ruleId: 'reorder-stmts', mutationTargetId: 'mt-0' });
      expect(store.getSummary().bestScore).toBe(100);
    });

    it('compilation-error bumps target attempts and rule errors', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({ type: 'compilation-error', mutationTargetId: 'mt-0', ruleId: 'cast-expr', error: 'syntax error' });
      store.push({ type: 'compilation-error', mutationTargetId: 'mt-0', ruleId: 'cast-expr', error: 'syntax error' });

      const target = store.getGraph().mutationTargets[0]!;
      expect(target.attempts).toBe(2);
      expect(target.attemptsWithoutFork).toBe(2);

      const castStats = store.getRuleStats().find((s) => s.ruleId === 'cast-expr')!;
      expect(castStats.errors).toBe(2);
      expect(castStats.applied).toBe(0);
    });

    it('forked event resets parent attemptsWithoutFork and sets lastImprovedAtIteration', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      // Accumulate some dry attempts.
      store.push({ type: 'scored', iteration: 1, score: 100, ruleId: 'cast-expr', mutationTargetId: 'mt-0' });
      store.push({ type: 'scored', iteration: 2, score: 100, ruleId: 'cast-expr', mutationTargetId: 'mt-0' });
      store.push({ type: 'scored', iteration: 3, score: 100, ruleId: 'cast-expr', mutationTargetId: 'mt-0' });
      expect(store.getGraph().mutationTargets[0]!.attemptsWithoutFork).toBe(3);

      // Now fork.
      store.push({
        type: 'forked',
        iteration: 3,
        parentCandidateId: 'genesis',
        candidateId: 'c-1',
        mutationTargetId: 'mt-1',
        oldScore: 100,
        newScore: 80,
        source: 'void f() { int a = 2; }',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 80, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });

      const parent = store.getGraph().mutationTargets.find((t) => t.id === 'mt-0')!;
      expect(parent.attemptsWithoutFork).toBe(0);
      expect(parent.lastImprovedAtIteration).toBe(3);
      // attempts is not decremented — it still counts every mutation tried.
      expect(parent.attempts).toBe(3);
    });

    it('forked event accumulates deltaByType from parent vs child breakdowns', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      // Genesis candidate with a non-trivial breakdown.
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
        breakdown: { total: 100, insert: 10, delete: 5, replace: 20, opMismatch: 3, argMismatch: 2 },
      });
      // Fork that fixes 3 inserts and 1 replace.
      store.push({
        type: 'forked',
        iteration: 1,
        parentCandidateId: 'genesis',
        candidateId: 'c-1',
        mutationTargetId: 'mt-1',
        oldScore: 100,
        newScore: 80,
        source: 'x',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 80, insert: 7, delete: 5, replace: 19, opMismatch: 3, argMismatch: 2 },
      });

      const stats = store.getRuleStats().find((s) => s.ruleId === 'reorder-stmts')!;
      expect(stats.deltaByType.insert).toBe(3);
      expect(stats.deltaByType.delete).toBe(0);
      expect(stats.deltaByType.replace).toBe(1);
      expect(stats.deltaByType.opMismatch).toBe(0);
      expect(stats.deltaByType.argMismatch).toBe(0);
      // Fork-level totals also recorded on the rule.
      expect(stats.forked).toBe(1);
      expect(stats.bestDelta).toBe(20);
      expect(stats.avgDelta).toBe(20);
    });

    it('stats event updates bestScore and totals', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'stats',
        iteration: 50,
        elapsed: 2500,
        targets: [{ id: 'mt-0', candidateId: 'genesis', score: 70, weight: 1, attempts: 50, enabled: true }],
        bestScore: 70,
        candidateCount: 3,
        compiled: 45,
        errors: 3,
        deduped: 2,
        rulesUsed: {},
      });

      const summary = store.getSummary();
      expect(summary.bestScore).toBe(70);
      expect(summary.elapsed).toBe(2500);
      expect(summary.totalCompiled).toBe(45);
      expect(summary.totalErrors).toBe(3);
      expect(summary.totalDeduped).toBe(2);
      expect(summary.totalIterations).toBe(50);
    });

    it('stats event does not regress bestScore when newer value is worse', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({
        type: 'forked',
        iteration: 1,
        parentCandidateId: 'genesis',
        candidateId: 'c-1',
        mutationTargetId: 'mt-1',
        oldScore: 100,
        newScore: 40,
        source: 'x',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 40, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      expect(store.getSummary().bestScore).toBe(40);

      // A subsequent stats event reporting a worse best must NOT overwrite it.
      store.push({
        type: 'stats',
        iteration: 10,
        elapsed: 1000,
        targets: [],
        bestScore: 80,
        candidateCount: 2,
        compiled: 10,
        errors: 0,
        deduped: 0,
        rulesUsed: {},
      });
      expect(store.getSummary().bestScore).toBe(40);
    });

    it('forked event does not regress bestScore when a later fork is worse', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      const fork = (candidateId: string, newScore: number) =>
        store.push({
          type: 'forked',
          iteration: 1,
          parentCandidateId: 'genesis',
          candidateId,
          mutationTargetId: `mt-${candidateId}`,
          oldScore: 100,
          newScore,
          source: 'x',
          ruleId: 'reorder-stmts',
          location: { line: 1, column: 1 },
          assembly: '',
          assemblyDiff: '',
          breakdown: { total: newScore, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
        });

      fork('c-1', 40);
      fork('c-2', 60); // lateral fork — worse than current best
      expect(store.getSummary().bestScore).toBe(40);
    });
  });

  describe('query API', () => {
    beforeEach(() => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });

      // Simulate a series of mutations with some forks
      for (let i = 1; i <= 10; i++) {
        const score = 100 - i * 5;
        const forked = i % 3 === 0; // fork every 3rd iteration
        store.push({
          type: 'scored',
          iteration: i,
          score: forked ? score : 100,
          ruleId: forked ? 'reorder-stmts' : 'cast-expr',
          mutationTargetId: 'mt-0',
        });
        if (forked) {
          store.push({
            type: 'forked',
            iteration: i,
            parentCandidateId: 'genesis',
            candidateId: `c-${i}`,
            mutationTargetId: 'mt-0',
            oldScore: score + 5,
            newScore: score,
            source: `void test_func() { int a = ${i}; }`,
            ruleId: 'reorder-stmts',
            location: { line: 1, column: 1 },
            assembly: '',
            assemblyDiff: '',
            breakdown: { total: 0, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
          });
        }
      }
    });

    it('getSummary returns correct aggregates', () => {
      const summary = store.getSummary();
      expect(summary.baseScore).toBe(100);
      expect(summary.totalCompiled).toBe(10);
      expect(summary.forkCount).toBe(3); // iterations 3, 6, 9
    });

    it('getAllCandidates returns all candidates', () => {
      const candidates = store.getAllCandidates();
      expect(candidates.length).toBeGreaterThan(0);
    });

    it('getBestCandidate returns the candidate with the lowest score', () => {
      const best = store.getBestCandidate();
      // Forks fire at i=3,6,9 with score = 100 - i*5 → 85, 70, 55.
      expect(best).toBeDefined();
      expect(best!.score).toBe(55);
      expect(best!.id).toBe('c-9');
    });

    it('getCandidate returns a candidate by id or undefined', () => {
      expect(store.getCandidate('c-3')).toBeDefined();
      expect(store.getCandidate('c-3')!.score).toBe(85);
      expect(store.getCandidate('does-not-exist')).toBeUndefined();
    });

    it('getLineage returns [self] for genesis and [self, parent, ..., genesis] otherwise', () => {
      // Every fork in the setup has parent=genesis, so lineage is exactly two nodes.
      const lineage = store.getLineage('c-9');
      expect(lineage.map((c) => c.id)).toEqual(['c-9', 'genesis']);

      expect(store.getLineage('genesis').map((c) => c.id)).toEqual(['genesis']);
      expect(store.getLineage('does-not-exist')).toEqual([]);
    });

    it('getChildren returns only direct children', () => {
      // All 3 forks are direct children of genesis.
      const children = store
        .getChildren('genesis')
        .map((c) => c.id)
        .sort();
      expect(children).toEqual(['c-3', 'c-6', 'c-9']);

      // Leaves have no children.
      expect(store.getChildren('c-3')).toEqual([]);
    });

    it('getRuleStats returns per-rule statistics', () => {
      const stats = store.getRuleStats();
      const reorderStats = stats.find((s) => s.ruleId === 'reorder-stmts');
      expect(reorderStats).toBeDefined();
      expect(reorderStats!.forked).toBe(3);
      expect(reorderStats!.successRate).toBeGreaterThan(0);

      const castStats = stats.find((s) => s.ruleId === 'cast-expr');
      expect(castStats).toBeDefined();
      expect(castStats!.forked).toBe(0);
    });

    it('getRuleStats has empty description by default', () => {
      const stats = store.getRuleStats();
      for (const s of stats) {
        expect(s.description).toBe('');
      }
    });

    it('getRuleStats picks up descriptions from started event', () => {
      const s2 = new SessionStore();
      s2.push({
        type: 'started',
        baseScore: 100,
        targetCount: 1,
        ruleDescriptions: {
          'reorder-stmts': 'Randomly reorder adjacent statements',
          'cast-expr': 'Add or remove type casts',
        },
      });
      s2.push({ type: 'scored', iteration: 1, score: 95, ruleId: 'reorder-stmts', mutationTargetId: 'mt-0' });
      s2.push({ type: 'scored', iteration: 2, score: 95, ruleId: 'cast-expr', mutationTargetId: 'mt-0' });

      const stats = s2.getRuleStats();
      expect(stats.find((s) => s.ruleId === 'reorder-stmts')!.description).toBe('Randomly reorder adjacent statements');
      expect(stats.find((s) => s.ruleId === 'cast-expr')!.description).toBe('Add or remove type casts');
    });
  });

  describe('lineage and summary aggregates', () => {
    it('getLineage walks a multi-level parent chain in depth order', () => {
      // Build genesis → c1 → c2 → c3 so lineage has four entries.
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      const pushFork = (parent: string, id: string, score: number) => {
        store.push({
          type: 'forked',
          iteration: 1,
          parentCandidateId: parent,
          candidateId: id,
          mutationTargetId: `mt-${id}`,
          oldScore: 100,
          newScore: score,
          source: 'x',
          ruleId: 'reorder-stmts',
          location: { line: 1, column: 1 },
          assembly: '',
          assemblyDiff: '',
          breakdown: { total: score, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
        });
        store.push({
          type: 'mutation-target-created',
          mutationTargetId: `mt-${id}`,
          candidateId: id,
          score,
          origin: 'organic',
        });
      };
      pushFork('genesis', 'c1', 90);
      pushFork('c1', 'c2', 80);
      pushFork('c2', 'c3', 70);

      expect(store.getLineage('c3').map((c) => c.id)).toEqual(['c3', 'c2', 'c1', 'genesis']);
      expect(store.getChildren('c1').map((c) => c.id)).toEqual(['c2']);
      expect(store.getBestCandidate()!.id).toBe('c3');
    });

    it('getSummary computes avgForkInterval from elapsed and forkCount', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });

      // One fork only — avgForkInterval requires >= 2 forks, so it stays 0.
      store.push({
        type: 'forked',
        iteration: 1,
        parentCandidateId: 'genesis',
        candidateId: 'c-1',
        mutationTargetId: 'mt-1',
        oldScore: 100,
        newScore: 90,
        source: 'x',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 90, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'stats',
        iteration: 1,
        elapsed: 2000,
        targets: [],
        bestScore: 90,
        candidateCount: 1,
        compiled: 1,
        errors: 0,
        deduped: 0,
        rulesUsed: {},
      });
      expect(store.getSummary().avgForkInterval).toBe(0);

      // Second fork brings the count to 2 at elapsed 4000ms → 2000ms/fork.
      store.push({
        type: 'forked',
        iteration: 2,
        parentCandidateId: 'genesis',
        candidateId: 'c-2',
        mutationTargetId: 'mt-2',
        oldScore: 100,
        newScore: 80,
        source: 'x',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 80, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'stats',
        iteration: 2,
        elapsed: 4000,
        targets: [],
        bestScore: 80,
        candidateCount: 2,
        compiled: 2,
        errors: 0,
        deduped: 0,
        rulesUsed: {},
      });

      const summary = store.getSummary();
      expect(summary.forkCount).toBe(2);
      expect(summary.avgForkInterval).toBe(2000);
      expect(summary.scoreDelta).toBe(20);
    });

    it('getSummary reports perfectMatch only when bestScore is 0', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      expect(store.getSummary().perfectMatch).toBe(false);

      store.push({ type: 'perfect-match', iteration: 42, source: 'x', candidateId: 'c-0' });
      expect(store.getSummary().perfectMatch).toBe(true);
      expect(store.getSummary().bestScore).toBe(0);
    });
  });

  describe('focus constraint tracking', () => {
    it('tracks focus-mutation events', () => {
      const storeWithFocus = new SessionStore({
        focusConstraints: [
          {
            type: 'focus-region',
            id: 'fix-line-3',
            description: 'Focus on line 3',
            lines: { start: 3, end: 4 },
          },
        ],
      });

      storeWithFocus.push({
        type: 'focus-mutation',
        constraintId: 'fix-line-3',
        ruleId: 'reorder-stmts',
        improved: false,
      });
      storeWithFocus.push({
        type: 'focus-mutation',
        constraintId: 'fix-line-3',
        ruleId: 'reorder-stmts',
        improved: true,
      });

      const results = storeWithFocus.getFocusResults();
      expect(results).toHaveLength(1);
      expect(results[0]!.mutationsAttempted).toBe(2);
      expect(results[0]!.mutationsForked).toBe(1);
    });

    it('tracks focus-rejected events', () => {
      const storeWithFocus = new SessionStore({
        focusConstraints: [
          {
            type: 'avoid-region',
            id: 'protect-loop',
            description: 'Protect lines 10-15',
            lines: { start: 10, end: 15 },
          },
        ],
      });

      storeWithFocus.push({
        type: 'focus-rejected',
        constraintId: 'protect-loop',
        ruleId: 'reorder-stmts',
        reason: 'avoid-region',
      });
      storeWithFocus.push({
        type: 'focus-rejected',
        constraintId: 'protect-loop',
        ruleId: 'cast-expr',
        reason: 'avoid-region',
      });

      const results = storeWithFocus.getFocusResults();
      expect(results[0]!.mutationsRejected).toBe(2);
    });

    it('tracks hypothesis-scored events', () => {
      const storeWithFocus = new SessionStore({
        focusConstraints: [
          {
            type: 'hypothesis',
            id: 'swap-idea',
            description: 'Try swapping assignments',
            source: 'void test() { int b = 2; int a = 1; }',
          },
        ],
      });
      storeWithFocus.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });
      storeWithFocus.push({
        type: 'hypothesis-scored',
        constraintId: 'swap-idea',
        score: 85,
        mutationTargetId: 'mt-1',
      });

      const results = storeWithFocus.getFocusResults();
      expect(results[0]!.hypothesisScore).toBe(85);
      expect(results[0]!.hypothesisMutationTargetId).toBe('mt-1');
    });
  });

  describe('auto-compacted event triggers summarize', () => {
    /**
     * Reproduces the bug: when auto-compact fires internally, Pool.summarize()
     * frees candidates, but the SessionStore never runs its own summarize().
     * The graph/report still shows all lifetime candidates with no superNodes.
     *
     * The fix: SessionStore.push() should handle the 'auto-compacted' event
     * by calling this.summarize(), which cleans up dead branches and creates
     * superNodes that appear in getGraph() and toJSON().
     */
    it('summarizes store and produces superNodes when auto-compacted event is received', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });

      // Build a small tree:
      //   genesis (mt-0, score 100) → fork1 (mt-1, score 90) → fork2 (mt-2, score 80)
      //                              → fork3 (mt-3, score 95)
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({
        type: 'forked',
        iteration: 1,
        parentCandidateId: 'genesis',
        candidateId: 'fork1',
        mutationTargetId: 'mt-1',
        oldScore: 100,
        newScore: 90,
        source: 'fork1 source',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 90, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-1',
        candidateId: 'fork1',
        score: 90,
        origin: 'organic',
      });

      store.push({
        type: 'forked',
        iteration: 2,
        parentCandidateId: 'fork1',
        candidateId: 'fork2',
        mutationTargetId: 'mt-2',
        oldScore: 90,
        newScore: 80,
        source: 'fork2 source',
        ruleId: 'delete-stmt',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 80, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-2',
        candidateId: 'fork2',
        score: 80,
        origin: 'organic',
      });

      store.push({
        type: 'forked',
        iteration: 3,
        parentCandidateId: 'genesis',
        candidateId: 'fork3',
        mutationTargetId: 'mt-3',
        oldScore: 100,
        newScore: 95,
        source: 'fork3 source',
        ruleId: 'cast-expr',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 95, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-3',
        candidateId: 'fork3',
        score: 95,
        origin: 'organic',
      });

      // Now simulate auto-compact: disable mt-0 (genesis) and mt-3 (fork3),
      // keeping only mt-1 and mt-2 on the active lineage: genesis → fork1 → fork2
      store.push({ type: 'mutation-target-disabled', mutationTargetId: 'mt-0' });
      store.push({ type: 'mutation-target-disabled', mutationTargetId: 'mt-3' });

      // Before the auto-compacted event, graph still has all 4 candidates
      expect(store.getGraph().candidates).toHaveLength(4);

      // Fire auto-compacted event — this should trigger store.summarize()
      store.push({ type: 'auto-compacted', disabled: 2, removed: 1, superNodes: 1 });

      // After: fork3 is a dead branch (disabled, no enabled descendants).
      // It should be summarized into a superNode and removed from candidates.
      // genesis, fork1, fork2 remain (reachable from enabled mt-1 and mt-2).
      const graph = store.getGraph();
      expect(graph.candidates).toHaveLength(3);
      expect(graph.candidates.map((c) => c.id).sort()).toEqual(['fork1', 'fork2', 'genesis']);

      // SuperNodes should be present
      expect(graph.superNodes).toBeDefined();
      expect(graph.superNodes).toHaveLength(1);
      expect(graph.superNodes![0]!.summarizedCount).toBe(1);
      expect(graph.superNodes![0]!.bestScore).toBe(95);
      expect(graph.superNodes![0]!.parentId).toBe('genesis');

      // The dead branch's target should also be removed
      expect(graph.mutationTargets.find((t) => t.id === 'mt-3')).toBeUndefined();
    });

    it('includes superNodes in toJSON report after auto-compacted', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });

      // Simple tree: genesis → fork1 (active) and genesis → fork2 (will be disabled)
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-0',
        candidateId: 'genesis',
        score: 100,
        origin: 'genesis',
      });
      store.push({
        type: 'forked',
        iteration: 1,
        parentCandidateId: 'genesis',
        candidateId: 'fork1',
        mutationTargetId: 'mt-1',
        oldScore: 100,
        newScore: 80,
        source: 'fork1 src',
        ruleId: 'reorder-stmts',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 80, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-1',
        candidateId: 'fork1',
        score: 80,
        origin: 'organic',
      });

      store.push({
        type: 'forked',
        iteration: 2,
        parentCandidateId: 'genesis',
        candidateId: 'fork2',
        mutationTargetId: 'mt-2',
        oldScore: 100,
        newScore: 90,
        source: 'fork2 src',
        ruleId: 'delete-stmt',
        location: { line: 1, column: 1 },
        assembly: '',
        assemblyDiff: '',
        breakdown: { total: 90, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      });
      store.push({
        type: 'mutation-target-created',
        mutationTargetId: 'mt-2',
        candidateId: 'fork2',
        score: 90,
        origin: 'organic',
      });

      // Disable fork2's target, keep fork1 active
      store.push({ type: 'mutation-target-disabled', mutationTargetId: 'mt-0' });
      store.push({ type: 'mutation-target-disabled', mutationTargetId: 'mt-2' });

      // Trigger auto-compact
      store.push({ type: 'auto-compacted', disabled: 2, removed: 1, superNodes: 1 });

      const report = store.toJSON();
      expect(report.graph.superNodes).toBeDefined();
      expect(report.graph.superNodes!.length).toBeGreaterThan(0);
      // fork2 removed, genesis and fork1 remain
      expect(report.graph.candidates).toHaveLength(2);
    });
  });

  describe('JSON serialization', () => {
    it('toJSON produces valid structure', () => {
      store.push({ type: 'started', baseScore: 50, targetCount: 1, ruleDescriptions: {} });

      const json = store.toJSON();
      expect(json.version).toBe(1);
      expect(json.type).toBe('match');
      expect(json.metadata.sessionId).toBe('test-session');
      expect(json.config.functionName).toBe('test_func');
      expect(json.summary.baseScore).toBe(50);
      expect(Array.isArray(json.ruleStats)).toBe(true);
      expect(Array.isArray(json.graph.candidates)).toBe(true);
      expect(Array.isArray(json.graph.mutationTargets)).toBe(true);
      expect(Array.isArray(json.scoreTimeline)).toBe(true);
      expect(Array.isArray(json.focusResults)).toBe(true);
    });

    it('toJSON includes ruleStats with descriptions from started event', () => {
      store.push({
        type: 'started',
        baseScore: 100,
        targetCount: 1,
        ruleDescriptions: { 'reorder-stmts': 'Swap adjacent statements' },
      });
      store.push({ type: 'scored', iteration: 1, score: 95, ruleId: 'reorder-stmts', mutationTargetId: 'mt-0' });

      const json = store.toJSON();
      const rule = json.ruleStats.find((r) => r.ruleId === 'reorder-stmts');
      expect(rule).toBeDefined();
      expect(rule!.description).toBe('Swap adjacent statements');
    });

    it('toJSON does not include topRules or ruleDescriptions', () => {
      store.push({ type: 'started', baseScore: 100, targetCount: 1, ruleDescriptions: {} });

      const json = store.toJSON();
      expect('topRules' in json.summary).toBe(false);
      expect('ruleDescriptions' in json).toBe(false);
    });
  });
});
