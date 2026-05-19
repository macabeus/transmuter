/**
 * Captures MutationSearch events and provides a typed query API.
 *
 * Wire it to the MutationSearch's onEvent callback via push(), then query
 * during or after the session. Serializes to JSON for the webapp.
 */
import { extractFunctionDefinition } from '~/isolate/extract-function.js';
import type {
  CandidateNode,
  DiffBreakdown,
  FocusConstraint,
  FocusResult,
  MutationSearchEvent,
  MutationTarget,
  RuleStatsEntry,
  SessionConfig,
  SessionMetadata,
  SessionReport,
  SessionStoreOptions,
  SessionSummary,
  SuperNode,
  TimelinePoint,
} from '~/types.js';

type ForkedEvent = Extract<MutationSearchEvent, { type: 'forked' }>;

/** Sentinel meaning "no score has been recorded yet". */
const UNSET_SCORE = -1;

/** Fallback config used by toJSON() when setConfig() was never called. */
const EMPTY_CONFIG: SessionConfig = {
  functionName: '',
  targetObjectPath: '',
  compilerCommand: '',
  language: 'c',
  concurrency: 0,
  maxCompiles: 0,
  timeoutMs: 0,
  seed: 0,
  mutationDepth: 1,
  lateralForkBudget: 0,
  ruleWeights: {},
  disabledRules: [],
  focusConstraints: [],
};

function defaultBreakdown(score: number): DiffBreakdown {
  return { total: score, insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 };
}

interface InternalRuleStats {
  applied: number;
  forked: number;
  totalDelta: number;
  bestDelta: number;
  errors: number;
  deltaByType: { insert: number; delete: number; replace: number; opMismatch: number; argMismatch: number };
}

interface InternalTarget {
  id: string;
  candidateId: string;
  weight: number;
  enabled: boolean;
  attempts: number;
  attemptsWithoutFork: number;
  createdAt: number;
  lastImprovedAtIteration: number | null;
  origin: CandidateNode['origin'];
}

interface InternalFocusTracker {
  constraint: FocusConstraint;
  mutationsAttempted: number;
  mutationsForked: number;
  mutationsRejected: number;
  hypothesisScore?: number;
  hypothesisMutationTargetId?: string;
}

export class SessionStore {
  // SessionMetadata is readonly in the public API; strip readonly internally
  // so `completedAt` / `partial` can be updated as the session progresses.
  #metadata: { -readonly [K in keyof SessionMetadata]: SessionMetadata[K] };
  #config: SessionConfig | null = null;
  #baseScore = UNSET_SCORE;
  #bestScore = UNSET_SCORE;
  #completionReason?: string;

  // Graph data
  #candidates = new Map<string, CandidateNode>();
  #targets = new Map<string, InternalTarget>();
  #superNodes: SuperNode[] = [];

  // Indexed data
  #ruleStats = new Map<string, InternalRuleStats>();
  #focusTrackers = new Map<string, InternalFocusTracker>();
  #scoreTimeline: TimelinePoint[] = [];

  // Counters
  #totalCompiled = 0;
  #totalErrors = 0;
  #totalDeduped = 0;
  #totalIterations = 0;
  #elapsed = 0;
  #forkCount = 0;
  #startTime = 0;

  // Source tracking
  #originalSource = '';
  #contextSource: string | undefined;
  #ruleDescriptions: Record<string, string> = {};

  constructor(options: SessionStoreOptions = {}) {
    this.#metadata = {
      sessionId: options.metadata?.sessionId ?? `session-${Date.now()}`,
      label: options.metadata?.label,
      tags: options.metadata?.tags,
      createdAt: new Date().toISOString(),
    };

    for (const constraint of options.focusConstraints ?? []) {
      this.#focusTrackers.set(constraint.id, {
        constraint,
        mutationsAttempted: 0,
        mutationsForked: 0,
        mutationsRejected: 0,
      });
    }
  }

  /** Set the session config (called once when the session starts). */
  setConfig(config: SessionConfig): void {
    this.#config = config;
  }

  /** Set the original source for diff generation. */
  setOriginalSource(source: string): void {
    this.#originalSource = source;
  }

  /**
   * Set the pre-isolation source ("context"). Serialized in the report so the
   * webapp can show it alongside each candidate's isolated source.
   */
  setContextSource(source: string): void {
    this.#contextSource = source;
  }

  /** The pre-isolation source if one was recorded, otherwise undefined. */
  getContextSource(): string | undefined {
    return this.#contextSource;
  }

  /** The target function name from the session config. Empty string if unset. */
  getFunctionName(): string {
    return this.#config?.functionName ?? '';
  }

  /** Process a MutationSearchEvent. Safe to call from the onEvent callback. */
  push(event: MutationSearchEvent): void {
    switch (event.type) {
      case 'started':
        this.#baseScore = event.baseScore;
        this.#bestScore = event.baseScore;
        this.#startTime = Date.now();
        if (event.ruleDescriptions) {
          this.#ruleDescriptions = event.ruleDescriptions;
        }
        // Anchor the timeline at (iteration 0, baseScore) so the chart has a
        // starting point even if the run finishes before the first stats tick.
        this.#pushTimelinePoint(0, event.baseScore, 0);
        break;

      case 'scored':
        this.#advanceIteration(event.iteration);
        this.#totalCompiled++;
        this.#ensureRuleStats(event.ruleId).applied++;
        this.#bumpTargetAttempt(event.mutationTargetId);
        break;

      case 'forked': {
        this.#advanceIteration(event.iteration);
        this.#forkCount++;
        this.#markParentForked(event.parentCandidateId, event.iteration);
        this.#recordForkRuleStats(event);
        const isImprovement = this.#bestScore < 0 || event.newScore < this.#bestScore;
        this.#updateBestScore(event.newScore);
        this.#candidates.set(event.candidateId, {
          id: event.candidateId,
          source: event.source,
          score: event.newScore,
          iteration: event.iteration,
          timestamp: Date.now(),
          mutationTargetId: event.mutationTargetId,
          parentId: event.parentCandidateId,
          origin: 'organic',
          ruleId: event.ruleId,
          location: event.location,
          assembly: event.assembly,
          assemblyDiff: event.assemblyDiff,
          breakdown: event.breakdown,
        });
        // Record the score drop at the exact iteration it occurred. Stats
        // events are too coarse to capture every improvement and some are
        // dropped entirely when the run finishes between boundaries.
        if (isImprovement) {
          this.#pushTimelinePoint(event.iteration, event.newScore, this.#currentElapsed());
        }
        break;
      }

      case 'compilation-error':
        this.#totalErrors++;
        this.#ensureRuleStats(event.ruleId).errors++;
        this.#bumpTargetAttempt(event.mutationTargetId);
        break;

      case 'scorer-failed':
        // Compile succeeded; scoring failed. Count it as an error so the
        // report's totalErrors / per-rule errors reflect the failed attempt,
        // and bump the target's attempt counter (same as compilation-error).
        this.#totalErrors++;
        this.#ensureRuleStats(event.ruleId).errors++;
        this.#bumpTargetAttempt(event.mutationTargetId);
        break;

      case 'mutation-target-created':
        this.#targets.set(event.mutationTargetId, {
          id: event.mutationTargetId,
          candidateId: event.candidateId,
          weight: 1,
          enabled: true,
          attempts: 0,
          attemptsWithoutFork: 0,
          createdAt: Date.now(),
          lastImprovedAtIteration: null,
          origin: event.origin,
        });
        // Organic candidates are already created by the 'forked' event that
        // precedes this one; only genesis/external roots need to be
        // materialized here.
        if ((event.origin === 'genesis' || event.origin === 'external') && !this.#candidates.has(event.candidateId)) {
          this.#candidates.set(event.candidateId, {
            id: event.candidateId,
            source: event.source ?? this.#originalSource,
            score: event.score,
            iteration: 0,
            timestamp: Date.now(),
            mutationTargetId: event.mutationTargetId,
            origin: event.origin,
            assembly: event.assembly ?? '',
            assemblyDiff: event.assemblyDiff ?? '',
            breakdown: event.breakdown ?? defaultBreakdown(event.score),
          });
        }
        break;

      case 'mutation-target-disabled': {
        const target = this.#targets.get(event.mutationTargetId);
        if (target) {
          target.enabled = false;
        }
        break;
      }

      case 'mutation-target-enabled': {
        const target = this.#targets.get(event.mutationTargetId);
        if (target) {
          target.enabled = true;
        }
        break;
      }

      case 'mutation-target-weight-changed': {
        const target = this.#targets.get(event.mutationTargetId);
        if (target) {
          target.weight = event.weight;
        }
        break;
      }

      case 'stats':
        this.#advanceIteration(event.iteration);
        this.#elapsed = event.elapsed;
        this.#totalCompiled = event.compiled;
        this.#totalErrors = event.errors;
        this.#totalDeduped = event.deduped;
        this.#updateBestScore(event.bestScore);
        this.#pushTimelinePoint(event.iteration, event.bestScore, event.elapsed);
        break;

      case 'completed':
        this.#advanceIteration(event.totalIterations);
        this.#elapsed = event.elapsed;
        this.#completionReason = event.reason;
        this.#metadata.completedAt = new Date().toISOString();
        this.#updateBestScore(event.finalScore);
        // Close out the timeline with the final state so the chart extends
        // all the way to the run's actual end, not just the last stats tick.
        this.#pushTimelinePoint(event.totalIterations, event.finalScore, event.elapsed);
        break;

      case 'perfect-match':
        this.#bestScore = 0;
        this.#advanceIteration(event.iteration);
        this.#pushTimelinePoint(event.iteration, 0, this.#currentElapsed());
        break;

      case 'focus-mutation': {
        const tracker = this.#focusTrackers.get(event.constraintId);
        if (tracker) {
          tracker.mutationsAttempted++;
          if (event.improved) {
            tracker.mutationsForked++;
          }
        }
        break;
      }

      case 'focus-rejected': {
        const tracker = this.#focusTrackers.get(event.constraintId);
        if (tracker) {
          tracker.mutationsRejected++;
        }
        break;
      }

      case 'hypothesis-scored': {
        const tracker = this.#focusTrackers.get(event.constraintId);
        if (tracker) {
          tracker.hypothesisScore = event.score;
          tracker.hypothesisMutationTargetId = event.mutationTargetId;
        }
        break;
      }

      case 'auto-compacted':
        // Pool.summarize() already freed candidates from the pool. By this
        // point, 'mutation-target-disabled' events have arrived, so the store's
        // enabled/disabled state matches the pool. Run our own summarize() to
        // mirror the pool's compaction: delete unreachable candidates/targets
        // and create SuperNodes.
        this.summarize();
        break;

      // graph-summarized / error are intentionally unhandled — the store
      // derives no state from them.
    }
  }

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  getSummary(): SessionSummary {
    const activeTargetCount = [...this.#targets.values()].filter((t) => t.enabled).length;
    const avgForkInterval = this.#forkCount >= 2 && this.#elapsed > 0 ? this.#elapsed / this.#forkCount : 0;

    return {
      baseScore: this.#baseScore,
      bestScore: this.#bestScore,
      scoreDelta: this.#baseScore >= 0 ? this.#baseScore - this.#bestScore : 0,
      perfectMatch: this.#bestScore === 0,
      totalIterations: this.#totalIterations,
      elapsed: this.#elapsed,
      totalCompiled: this.#totalCompiled,
      totalErrors: this.#totalErrors,
      totalDeduped: this.#totalDeduped,
      forkCount: this.#forkCount,
      targetCount: this.#targets.size,
      activeTargetCount,
      completionReason: this.#completionReason,
      avgForkInterval,
    };
  }

  getCandidate(id: string): CandidateNode | undefined {
    return this.#candidates.get(id);
  }

  getAllCandidates(): CandidateNode[] {
    return [...this.#candidates.values()];
  }

  getBestCandidate(): CandidateNode | undefined {
    let best: CandidateNode | undefined;
    for (const c of this.#candidates.values()) {
      if (!best || c.score < best.score) {
        best = c;
      }
    }
    return best;
  }

  getLineage(candidateId: string): CandidateNode[] {
    const lineage: CandidateNode[] = [];
    let current = this.#candidates.get(candidateId);
    while (current) {
      lineage.push(current);
      current = current.parentId ? this.#candidates.get(current.parentId) : undefined;
    }
    return lineage;
  }

  getChildren(candidateId: string): CandidateNode[] {
    return [...this.#candidates.values()].filter((c) => c.parentId === candidateId);
  }

  getGraph(): { candidates: CandidateNode[]; mutationTargets: MutationTarget[]; superNodes?: SuperNode[] } {
    return {
      candidates: this.getAllCandidates(),
      mutationTargets: [...this.#targets.values()].map(toPublicTarget),
      ...(this.#superNodes.length > 0 ? { superNodes: this.#superNodes } : {}),
    };
  }

  getRuleStats(): RuleStatsEntry[] {
    const entries: RuleStatsEntry[] = [];
    for (const [ruleId, stats] of this.#ruleStats) {
      entries.push({
        ruleId,
        description: this.#ruleDescriptions[ruleId] ?? '',
        applied: stats.applied,
        forked: stats.forked,
        successRate: stats.applied > 0 ? stats.forked / stats.applied : 0,
        avgDelta: stats.forked > 0 ? stats.totalDelta / stats.forked : 0,
        bestDelta: stats.bestDelta,
        errors: stats.errors,
        // Kept in the public type for backward compatibility; the store has
        // never populated these (no event path increments them).
        focusApplied: 0,
        focusForked: 0,
        deltaByType: { ...stats.deltaByType },
      });
    }
    return entries.sort((a, b) => b.forked - a.forked);
  }

  getScoreTimeline(): TimelinePoint[] {
    return [...this.#scoreTimeline];
  }

  getFocusResults(): FocusResult[] {
    return [...this.#focusTrackers.values()].map((t) => ({
      constraintId: t.constraint.id,
      constraint: t.constraint,
      mutationsAttempted: t.mutationsAttempted,
      mutationsForked: t.mutationsForked,
      mutationsRejected: t.mutationsRejected,
      // bestRegionScore is kept in the public type but never populated.
      bestRegionScore: undefined,
      hypothesisScore: t.hypothesisScore,
      hypothesisMutationTargetId: t.hypothesisMutationTargetId,
      summary: this.#generateFocusSummary(t),
    }));
  }

  // ---------------------------------------------------------------------------
  // Graph summarization (compaction)
  // ---------------------------------------------------------------------------

  /**
   * Summarize dead-end subtrees into lightweight supernodes.
   * Mirrors Pool.summarize() — operates on SessionStore's own candidates/targets.
   */
  summarize(): void {
    const reachable = this.#reachableCandidateIds();
    const childrenOf = this.#buildChildrenIndex();

    // A "branch root" is a candidate whose parent is on an active lineage but
    // the branch itself is dead. It and its subtree get compacted into one
    // supernode (depth-0 compaction).
    const branchRoots: CandidateNode[] = [];
    for (const candidateId of reachable) {
      for (const child of childrenOf.get(candidateId) ?? []) {
        if (!reachable.has(child.id)) {
          branchRoots.push(child);
        }
      }
    }

    // An unreachable root tree has no enabled target anywhere in its lineage.
    // The entire tree gets compacted.
    const deadRoots: CandidateNode[] = [];
    for (const c of this.#candidates.values()) {
      if (!c.parentId && !reachable.has(c.id)) {
        deadRoots.push(c);
      }
    }

    const toDelete: string[] = [];
    for (const root of branchRoots) {
      const subtree = collectSubtree(root, childrenOf);
      this.#superNodes.push(this.#buildSuperNode(`supernode-${root.id}`, root.parentId, subtree));
      for (const c of subtree) {
        toDelete.push(c.id);
      }
    }
    for (const root of deadRoots) {
      const subtree = collectSubtree(root, childrenOf);
      this.#superNodes.push(this.#buildSuperNode(`supernode-root-${root.id}`, undefined, subtree));
      for (const c of subtree) {
        toDelete.push(c.id);
      }
    }

    for (const candidateId of toDelete) {
      const candidate = this.#candidates.get(candidateId);
      if (candidate) {
        this.#targets.delete(candidate.mutationTargetId);
      }
      this.#candidates.delete(candidateId);
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  toJSON(): SessionReport {
    return {
      version: 1,
      type: 'match',
      metadata: { ...this.#metadata },
      config: this.#config ?? EMPTY_CONFIG,
      summary: this.getSummary(),
      graph: this.#getGraphForReport(),
      ruleStats: this.getRuleStats(),
      scoreTimeline: this.getScoreTimeline(),
      focusResults: this.getFocusResults(),
      ...(this.#contextSource !== undefined && { contextSource: this.#contextSource }),
    };
  }

  /**
   * Like getGraph(), but each candidate's `source` is sliced down to the
   * target function definition. Used for the serialized report so consumers
   * (webapp, ctl) only see what Transmuter actually mutates. The in-memory
   * graph keeps the full source for engine consumers via getGraph().
   */
  #getGraphForReport(): { candidates: CandidateNode[]; mutationTargets: MutationTarget[]; superNodes?: SuperNode[] } {
    const graph = this.getGraph();
    const fnName = this.#config?.functionName;
    if (!fnName) {
      return graph;
    }
    return {
      ...graph,
      candidates: graph.candidates.map((c) => ({ ...c, source: extractFunctionDefinition(c.source, fnName) })),
    };
  }

  // ---------------------------------------------------------------------------
  // File I/O
  // ---------------------------------------------------------------------------

  async saveReportAtomic(outputPath: string): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const dir = path.dirname(outputPath);
    const tmpPath = path.join(dir, `.tmp-${path.basename(outputPath)}-${process.pid}`);
    const data = JSON.stringify(this.toJSON(), null, 2);
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, outputPath);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  #advanceIteration(iteration: number): void {
    if (iteration > this.#totalIterations) {
      this.#totalIterations = iteration;
    }
  }

  /** Record a new best score, taking the uninitialized sentinel into account. */
  #updateBestScore(score: number): void {
    if (this.#bestScore < 0 || score < this.#bestScore) {
      this.#bestScore = score;
    }
  }

  /** Wall-clock elapsed since the 'started' event, or 0 before it arrives. */
  #currentElapsed(): number {
    return this.#startTime > 0 ? Date.now() - this.#startTime : 0;
  }

  /**
   * Append a timeline point. Called from `started` (baseline), `forked`
   * (every score improvement), `stats` (periodic snapshot), `perfect-match`,
   * and `completed`. Adjacent duplicates (same iteration + same bestScore)
   * are collapsed so a stats tick that lands right after a fork doesn't
   * create a redundant entry.
   */
  #pushTimelinePoint(iteration: number, bestScore: number, elapsed: number): void {
    const last = this.#scoreTimeline[this.#scoreTimeline.length - 1];
    if (last && last.iteration === iteration && last.bestScore === bestScore) {
      return;
    }
    this.#scoreTimeline.push({
      iteration,
      elapsed,
      bestScore,
      targetCount: this.#targets.size,
      candidateCount: this.#candidates.size,
      compiledTotal: this.#totalCompiled,
    });
  }

  /** Bump attempts/attemptsWithoutFork on a target (no-op if unknown). */
  #bumpTargetAttempt(targetId: string): void {
    const target = this.#targets.get(targetId);
    if (target) {
      target.attempts++;
      target.attemptsWithoutFork++;
    }
  }

  /**
   * A fork improved a parent target. Reset its staleness counter. Each candidate
   * is produced by exactly one target, so the scan stops at the first hit.
   */
  #markParentForked(parentCandidateId: string, iteration: number): void {
    for (const t of this.#targets.values()) {
      if (t.candidateId === parentCandidateId) {
        t.lastImprovedAtIteration = iteration;
        t.attemptsWithoutFork = 0;
        return;
      }
    }
  }

  #recordForkRuleStats(event: ForkedEvent): void {
    const stats = this.#ensureRuleStats(event.ruleId);
    stats.forked++;
    const delta = event.oldScore - event.newScore;
    stats.totalDelta += delta;
    if (delta > stats.bestDelta) {
      stats.bestDelta = delta;
    }

    // Per-diff-type improvement: parent breakdown minus child breakdown.
    const parent = this.#candidates.get(event.parentCandidateId);
    if (parent) {
      const pb = parent.breakdown;
      const cb = event.breakdown;
      stats.deltaByType.insert += pb.insert - cb.insert;
      stats.deltaByType.delete += pb.delete - cb.delete;
      stats.deltaByType.replace += pb.replace - cb.replace;
      stats.deltaByType.opMismatch += pb.opMismatch - cb.opMismatch;
      stats.deltaByType.argMismatch += pb.argMismatch - cb.argMismatch;
    }
  }

  #ensureRuleStats(ruleId: string): InternalRuleStats {
    let stats = this.#ruleStats.get(ruleId);
    if (!stats) {
      stats = {
        applied: 0,
        forked: 0,
        totalDelta: 0,
        bestDelta: 0,
        errors: 0,
        deltaByType: { insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 },
      };
      this.#ruleStats.set(ruleId, stats);
    }
    return stats;
  }

  #reachableCandidateIds(): Set<string> {
    const reachable = new Set<string>();
    for (const target of this.#targets.values()) {
      if (!target.enabled) {
        continue;
      }
      let current = this.#candidates.get(target.candidateId);
      while (current && !reachable.has(current.id)) {
        reachable.add(current.id);
        current = current.parentId ? this.#candidates.get(current.parentId) : undefined;
      }
    }
    return reachable;
  }

  #buildChildrenIndex(): Map<string, CandidateNode[]> {
    const childrenOf = new Map<string, CandidateNode[]>();
    for (const c of this.#candidates.values()) {
      if (!c.parentId) {
        continue;
      }
      const arr = childrenOf.get(c.parentId);
      if (arr) {
        arr.push(c);
      } else {
        childrenOf.set(c.parentId, [c]);
      }
    }
    return childrenOf;
  }

  #buildSuperNode(id: string, parentId: string | undefined, candidates: CandidateNode[]): SuperNode {
    let bestScore = Infinity;
    let worstScore = -Infinity;
    let bestSource = '';
    const rules = new Set<string>();

    for (const c of candidates) {
      if (c.score < bestScore) {
        bestScore = c.score;
        bestSource = c.source;
      }
      if (c.score > worstScore) {
        worstScore = c.score;
      }
      if (c.ruleId) {
        rules.add(c.ruleId);
      }
    }

    return {
      id,
      parentId,
      summarizedCount: candidates.length,
      bestScore,
      worstScore,
      rules: [...rules].sort(),
      bestSource,
    };
  }

  #generateFocusSummary(tracker: InternalFocusTracker): string {
    const c = tracker.constraint;
    switch (c.type) {
      case 'focus-region':
        return `${tracker.mutationsAttempted} mutations targeted lines ${c.lines.start}-${c.lines.end}; ${tracker.mutationsForked} produced forks.`;
      case 'avoid-region':
        return `Lines ${c.lines.start}-${c.lines.end} were protected; ${tracker.mutationsRejected} mutations were rejected for touching this region.`;
      case 'hypothesis':
        if (tracker.hypothesisScore !== undefined) {
          const targetInfo = tracker.hypothesisMutationTargetId
            ? ` Injected as ${tracker.hypothesisMutationTargetId}.`
            : '';
          return `The hypothesis scored ${tracker.hypothesisScore} (vs base ${this.#baseScore}).${targetInfo}`;
        }
        return 'Hypothesis not yet scored.';
    }
  }
}

function toPublicTarget(t: InternalTarget): MutationTarget {
  return {
    id: t.id,
    candidateId: t.candidateId,
    weight: t.weight,
    enabled: t.enabled,
    attempts: t.attempts,
    attemptsWithoutFork: t.attemptsWithoutFork,
    createdAt: t.createdAt,
    lastImprovedAtIteration: t.lastImprovedAtIteration,
  };
}

function collectSubtree(root: CandidateNode, childrenOf: Map<string, CandidateNode[]>): CandidateNode[] {
  const out: CandidateNode[] = [root];
  const queue = [...(childrenOf.get(root.id) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift()!;
    out.push(node);
    const children = childrenOf.get(node.id);
    if (children) {
      queue.push(...children);
    }
  }
  return out;
}
