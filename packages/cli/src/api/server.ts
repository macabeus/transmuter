/**
 * HTTP control server for the Transmuter CLI.
 *
 * All three modes (match, refine, cleanup) share the same common API surface
 * for querying candidates, controlling branches/rules, injecting code, etc.
 * Mode-specific endpoints (e.g., violations for refine) are layered on top.
 *
 * The server writes a discovery file so external processes can find the port.
 */
import { extractFunctionDefinition } from '@transmuter/core';
import type {
  ActiveSubSession,
  AvoidRegionConstraint,
  CandidateNode,
  Cleanup,
  FocusRegionConstraint,
  MutationSearch,
  MutationSearchState,
  MutationTarget,
  RefinementStore,
  Refiner,
  SessionStore,
  StructuredDifference,
} from '@transmuter/core';
import fs from 'fs/promises';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'path';

export interface ControlServerOptions {
  app: Hono;
  /** Directory where the discovery file is written */
  discoveryDir: string;
  /** Session ID for the discovery file */
  sessionId: string;
  /** Fixed port to bind to (default: 0 = random) */
  port?: number;
}

export interface ControlServer {
  /** The port the server is listening on */
  port: number;
  /** Path to the discovery file */
  discoveryPath: string;
  /** Shut down the server and remove the discovery file */
  close(): Promise<void>;
}

interface DiscoveryFile {
  pid: number;
  port: number;
  sessionId: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Shared endpoint descriptions
// ---------------------------------------------------------------------------

interface EndpointDescription {
  method: string;
  path: string;
  description: string;
}

/**
 * Common search-session interface shared by match, refine, and cleanup modes.
 *
 * MutationSearch, Refiner, and Cleanup all implement these methods.
 * When no sub-session is active (e.g., between refine phases), methods are
 * safe to call — control operations are no-ops, reads return empty/null.
 */
interface SearchLike {
  pause(): void;
  resume(): void;
  stop(): void;
  injectCode(
    source: string,
    options?: { label?: string },
  ): Promise<{ candidate: CandidateNode; target: MutationTarget } | null>;
  getAssemblyDiff(source: string): Promise<{
    assembly: string;
    targetAssembly: string;
    diff: string;
    differences: string[];
    structuredDifferences: StructuredDifference[];
    differenceCount: number;
    matchingCount: number;
  } | null>;
  setBranchWeight(mutationTargetId: string, weight: number): boolean;
  disableBranch(mutationTargetId: string): boolean;
  enableBranch(mutationTargetId: string): boolean;
  updateWeights(weights: Record<string, number>): string[];
  enableRule(ruleId: string): boolean;
  disableRule(ruleId: string): boolean;
  getRules(): { ruleId: string; description: string; weight: number; enabled: boolean }[];
  getBranchRuleHistory(branchId: string): { ruleId: string; trials: number; successRate: number }[] | null;
  setFocusConstraints(focusRegions: FocusRegionConstraint[], avoidRegions: AvoidRegionConstraint[]): void;
  getFocusConstraints(): { focusRegions: FocusRegionConstraint[]; avoidRegions: AvoidRegionConstraint[] };
  setMutationDepth(depth: number): void;
  getMutationDepth(): number;
  getState(): MutationSearchState;
  summarize(): { removed: number; superNodes: unknown[]; removedTargetIds: string[] };
}

// ---------------------------------------------------------------------------
// Common endpoint descriptions — shared by all modes
// ---------------------------------------------------------------------------

const COMMON_READ_ENDPOINTS: EndpointDescription[] = [
  {
    method: 'GET',
    path: '/session',
    description:
      'Current session snapshot. ' +
      'Fields: running, paused, functionName, iteration, elapsed, baseScore, bestScore, scoreDelta, bestSource, ' +
      'forkCount, totalCompiled, totalErrors, totalDeduped, targetCount, activeTargetCount, ' +
      'targets (MutationTarget[] with lastImprovedAtIteration), ruleWeights, completionReason, perfectMatch, avgForkInterval.',
  },
  {
    method: 'GET',
    path: '/candidates',
    description:
      "All CandidateNodes. Each candidate's `source` field is sliced to the target function definition (call /context-source for the full TU). " +
      'Supports query filters: ?maxScore=N, ?minScore=N, ?origin=genesis|organic|external, ?limit=N.',
  },
  {
    method: 'GET',
    path: '/candidates/best',
    description: 'The CandidateNode with the lowest score (best match). Returns null if no candidates exist.',
  },
  {
    method: 'GET',
    path: '/candidates/:id',
    description: 'A specific CandidateNode by its id. Returns null if not found.',
  },
  {
    method: 'GET',
    path: '/candidates/:id/lineage',
    description:
      'Ancestor chain from a candidate up to the genesis root. Array ordered [candidate, parent, grandparent, ...].',
  },
  {
    method: 'GET',
    path: '/candidates/:id/children',
    description: 'Direct children (forks) of a candidate.',
  },
  {
    method: 'GET',
    path: '/candidates/:id/delta',
    description:
      "Compare this candidate's assembly diff against its parent's to show what changed. " +
      'Returns { scoreBefore, scoreAfter, scoreDelta, ruleId, resolved (diffs fixed), ' +
      'introduced (new diffs), changed (diffs that shifted type/instruction) }. ' +
      '400 for genesis candidates (no parent). 422 if compilation fails.',
  },
  {
    method: 'GET',
    path: '/candidates/:id/assembly',
    description:
      "Compile this candidate's source and return assembly comparison against the target. " +
      'Returns { assembly, targetAssembly, diff (side-by-side), differences (detailed list), differenceCount, matchingCount }. ' +
      '422 if compilation fails. This is an on-demand operation that spawns a compiler subprocess.',
  },
  {
    method: 'GET',
    path: '/graph',
    description:
      'Full candidate graph: { candidates: CandidateNode[], mutationTargets: MutationTarget[] }. ' +
      'Candidate source fields are sliced to the target function definition.',
  },
  {
    method: 'GET',
    path: '/rules',
    description:
      'Rule catalog — every registered mutation rule with its current state. ' +
      'Returns [{ ruleId, description, weight, enabled }]. ' +
      'Weight reflects the effective priority (user override > profile default > rule default). ' +
      'enabled is false when the rule has been disabled via POST /rules/:id/disable.',
  },
  {
    method: 'GET',
    path: '/rules/history',
    description:
      'Session-wide aggregate rule statistics (cumulative, never reset). ' +
      'Returns [{ ruleId, description, applied, forked, successRate, avgDelta, bestDelta, errors, deltaByType }]. ' +
      'Sorted by fork count descending. Covers all branches over the entire session lifetime.',
  },
  {
    method: 'GET',
    path: '/rules/history/:branch_id',
    description:
      'Per-branch rule performance from the adaptive selector. ' +
      'Returns [{ ruleId, trials, successRate }] for rules that have been tried on this branch. ' +
      '404 if the branch does not exist. ' +
      'Note: unlike /rules/history (which is cumulative), per-branch stats use a sliding window ' +
      '(last ~500 trials per rule). Old results are evicted as new ones arrive, so these stats ' +
      'reflect recent performance, not all-time totals.',
  },
  {
    method: 'GET',
    path: '/timeline',
    description:
      'Score timeline sampled at regular intervals: iteration, elapsed, bestScore, targetCount, candidateCount.',
  },
  {
    method: 'GET',
    path: '/report',
    description:
      'Full SessionReport JSON (same format as the saved .json file). Contains all of the above plus config and metadata. ' +
      'Candidate source fields are sliced to the target function definition (see /context-source for the pre-isolation TU).',
  },
  {
    method: 'GET',
    path: '/context-source',
    description:
      'Pre-isolation source (the full TU passed to `transmuter match`) when `--isolate` was used. ' +
      'Returns { present: true, length, source } or { present: false } if isolation was not applied. ' +
      'Candidate sources in /candidates, /graph, /report, etc. are sliced to just the target function; this endpoint is the way to retrieve the surrounding context.',
  },
  {
    method: 'GET',
    path: '/diff-summary',
    description:
      'Structured diff summary for the best candidate with rule suggestions. ' +
      'Returns { score, breakdown: DiffBreakdown, structuredDifferences: StructuredDifference[], differenceCount, matchingCount, ' +
      'suggestedRules: [{ diffType, remaining, bestRules: [{ ruleId, deltaForType }] }] }. ' +
      'suggestedRules lists the top 5 historically effective rules for each remaining diff type. ' +
      '404 if no candidates exist. 422 if compilation fails.',
  },
];

const COMMON_CONTROL_ENDPOINTS: EndpointDescription[] = [
  {
    method: 'POST',
    path: '/pause',
    description: 'Pause all mutation slots. The session stays alive but stops processing.',
  },
  {
    method: 'POST',
    path: '/resume',
    description: 'Resume a paused session.',
  },
  {
    method: 'POST',
    path: '/stop',
    description: 'Stop the session. In-flight compilations are aborted. The session cannot be restarted.',
  },
  {
    method: 'POST',
    path: '/inject',
    description:
      'Inject external C source code. Compiles, scores, and returns assembly analysis. ' +
      'Body: { "source": "<C code>", "label": "<optional>", "dryRun": <optional bool> }. ' +
      'Always returns: score, structuredDifferences, differenceCount, matchingCount, assembly. ' +
      'Without dryRun (default): also creates a candidate and mutation target. The candidate fields (id, source, score, origin, ...) are returned at the top level alongside a nested target object: { id, source, score, ..., target, ...diffs }. ' +
      'With "dryRun": true: returns diffs only, no side effects. 422 if compilation fails. ' +
      'In refine mode: also returns violations[] — detected guideline violations in the injected source.',
  },
  {
    method: 'POST',
    path: '/branches/prune',
    description:
      'Disable branches in bulk based on filters, then automatically compact the graph ' +
      '(summarize dead-end subtrees into supernodes, freeing memory). ' +
      'Body: { "maxScore": N } disables all targets whose candidate score >= N. ' +
      'Body: { "keepBestN": N } keeps only the N lowest-scoring targets, disables the rest. ' +
      'Returns { disabled, remaining, compacted: { removed, superNodes, candidatesAfter } }.',
  },
  {
    method: 'POST',
    path: '/branches/:id/weight',
    description:
      'Set the scheduling weight for a mutation target. Higher weight = more mutation turns. ' +
      'Body: { "weight": <non-negative number> }.',
  },
  {
    method: 'POST',
    path: '/branches/:id/disable',
    description: 'Disable a mutation target. It is removed from scheduling but preserved in the graph.',
  },
  {
    method: 'POST',
    path: '/branches/:id/enable',
    description: 'Re-enable a previously disabled mutation target.',
  },
  {
    method: 'POST',
    path: '/batch',
    description:
      'Execute multiple control operations atomically. ' +
      'Body: { "operations": [{ "action": "...", ... }, ...] }. ' +
      'Supported actions: ' +
      '"pause", "resume", "stop" (no extra fields); ' +
      '"inject" ({ source, label? }); ' +
      '"set-branch-weight" ({ targetId, weight }); ' +
      '"disable-branch" ({ targetId }); ' +
      '"enable-branch" ({ targetId }); ' +
      '"update-rule-weights" ({ weights: { ruleId: weight } }); ' +
      '"enable-rule" ({ ruleId }); ' +
      '"disable-rule" ({ ruleId }); ' +
      '"prune" ({ maxScore? } or { keepBestN? }) — also auto-compacts the graph. ' +
      'Returns { results: [...] } with one result per operation.',
  },
  {
    method: 'POST',
    path: '/rules/weights',
    description:
      'Update mutation rule weights. Body: { "<ruleId>": <weight>, ... }. Weight 0 effectively disables a rule.',
  },
  {
    method: 'POST',
    path: '/rules/:id/enable',
    description: 'Enable a previously disabled mutation rule.',
  },
  {
    method: 'POST',
    path: '/rules/:id/disable',
    description: 'Disable a mutation rule. Disabled rules are never selected.',
  },
  {
    method: 'GET',
    path: '/focus',
    description:
      'Get current focus and avoid region constraints. Returns { focusRegions: FocusRegionConstraint[], avoidRegions: AvoidRegionConstraint[] }.',
  },
  {
    method: 'PUT',
    path: '/focus',
    description:
      'Replace focus and avoid region constraints. Body: { focusRegions?: [{ id, lines: { start, end }, strength? }], avoidRegions?: [{ id, lines: { start, end } }] }. ' +
      'Takes effect on the next mutation. Omitted arrays default to empty (clears constraints).',
  },
  {
    method: 'GET',
    path: '/mutation-depth',
    description: 'Get current mutation depth (number of chained mutations per iteration). Returns { depth: number }.',
  },
  {
    method: 'PUT',
    path: '/mutation-depth',
    description:
      'Set mutation depth. Body: { depth: <positive integer> }. Higher depth = more aggressive mutations per iteration.',
  },
];

const ALL_COMMON_ENDPOINTS = [...COMMON_READ_ENDPOINTS, ...COMMON_CONTROL_ENDPOINTS];

// ---------------------------------------------------------------------------
// Shared route registration
// ---------------------------------------------------------------------------

interface SearchRouteDeps {
  /** Returns the search-like object to forward control/query operations to. */
  getSearch(): SearchLike;
  /**
   * Returns the SessionStore for reading candidates, graph, rules, etc.
   * May return null when no sub-session is active (e.g., between refine phases).
   */
  getStore(): SessionStore | null;
}

/**
 * Register common search routes on a Hono app.
 * These routes are shared across match, refine, and cleanup modes.
 */
function registerSearchRoutes(app: Hono, deps: SearchRouteDeps): void {
  const { getSearch, getStore } = deps;

  /**
   * Slice a candidate's `source` field to just the target function definition
   * for outbound HTTP responses. Internal operations that compile or diff the
   * candidate keep using the raw source fetched directly from the store.
   */
  function slice<T extends { source: string }>(candidate: T, store: SessionStore | null): T {
    const fnName = store?.getFunctionName();
    if (!fnName) {
      return candidate;
    }
    return { ...candidate, source: extractFunctionDefinition(candidate.source, fnName) };
  }

  // -- Read operations --

  app.get('/session', (c) => {
    const store = getStore();
    const state = getSearch().getState();
    const summary = store?.getSummary();
    const fnName = store?.getFunctionName();
    return c.json({
      running: state.running,
      paused: state.paused,
      functionName: state.functionName,
      iteration: state.iteration,
      elapsed: state.elapsed,
      baseScore: summary?.baseScore ?? state.bestScore,
      bestScore: summary?.bestScore ?? state.bestScore,
      scoreDelta: summary?.scoreDelta ?? 0,
      perfectMatch: summary?.perfectMatch ?? false,
      bestSource: fnName ? extractFunctionDefinition(state.bestSource, fnName) : state.bestSource,
      forkCount: summary?.forkCount ?? 0,
      totalCompiled: summary?.totalCompiled ?? 0,
      totalErrors: summary?.totalErrors ?? 0,
      totalDeduped: summary?.totalDeduped ?? 0,
      targetCount: summary?.targetCount ?? state.targets.length,
      activeTargetCount: summary?.activeTargetCount ?? state.targets.filter((t) => t.enabled).length,
      targets: state.targets,
      ruleWeights: state.ruleWeights,
      completionReason: summary?.completionReason ?? null,
      avgForkInterval: summary?.avgForkInterval ?? null,
    });
  });

  app.get('/candidates', (c) => {
    const store = getStore();
    if (!store) {
      return c.json([]);
    }

    let candidates = store.getAllCandidates();

    const maxScore = c.req.query('maxScore');
    if (maxScore !== undefined) {
      const max = Number(maxScore);
      candidates = candidates.filter((cand) => cand.score <= max);
    }

    const minScore = c.req.query('minScore');
    if (minScore !== undefined) {
      const min = Number(minScore);
      candidates = candidates.filter((cand) => cand.score >= min);
    }

    const origin = c.req.query('origin');
    if (origin !== undefined) {
      candidates = candidates.filter((cand) => cand.origin === origin);
    }

    candidates.sort((a, b) => a.score - b.score);

    const limit = c.req.query('limit');
    if (limit !== undefined) {
      candidates = candidates.slice(0, Number(limit));
    }

    return c.json(candidates.map((cand) => slice(cand, store)));
  });

  app.get('/candidates/best', (c) => {
    const store = getStore();
    const best = store?.getBestCandidate();
    return c.json(best ? slice(best, store) : null);
  });

  app.get('/candidates/:id', (c) => {
    const store = getStore();
    const candidate = store?.getCandidate(c.req.param('id'));
    if (!candidate) {
      return c.json({ error: `Candidate '${c.req.param('id')}' not found` }, 404);
    }
    return c.json(slice(candidate, store));
  });

  app.get('/candidates/:id/lineage', (c) => {
    const store = getStore();
    if (!store?.getCandidate(c.req.param('id'))) {
      return c.json({ error: `Candidate '${c.req.param('id')}' not found` }, 404);
    }
    return c.json(store.getLineage(c.req.param('id')).map((cand) => slice(cand, store)));
  });

  app.get('/candidates/:id/children', (c) => {
    const store = getStore();
    if (!store?.getCandidate(c.req.param('id'))) {
      return c.json({ error: `Candidate '${c.req.param('id')}' not found` }, 404);
    }
    return c.json(store.getChildren(c.req.param('id')).map((cand) => slice(cand, store)));
  });

  app.get('/candidates/:id/delta', async (c) => {
    const store = getStore();
    const candidate = store?.getCandidate(c.req.param('id'));
    if (!candidate) {
      return c.json({ error: `Candidate '${c.req.param('id')}' not found` }, 404);
    }
    if (!candidate.parentId) {
      return c.json({ error: 'Genesis candidate has no parent to diff against' }, 400);
    }
    const parent = store?.getCandidate(candidate.parentId);
    if (!parent) {
      return c.json({ error: `Parent '${candidate.parentId}' not found` }, 404);
    }

    const search = getSearch();
    const [childDiff, parentDiff] = await Promise.all([
      search.getAssemblyDiff(candidate.source),
      search.getAssemblyDiff(parent.source),
    ]);
    if (!childDiff || !parentDiff) {
      return c.json({ error: 'Compilation failed or function not found' }, 422);
    }

    // Build lookup of parent diffs by row for fast comparison
    const parentByRow = new Map<number, (typeof parentDiff.structuredDifferences)[number]>();
    for (const d of parentDiff.structuredDifferences) {
      parentByRow.set(d.row, d);
    }

    const childByRow = new Map<number, (typeof childDiff.structuredDifferences)[number]>();
    for (const d of childDiff.structuredDifferences) {
      childByRow.set(d.row, d);
    }

    // Differences resolved by this candidate (in parent but not in child)
    const resolved = parentDiff.structuredDifferences.filter((d) => !childByRow.has(d.row));
    // Differences introduced by this candidate (in child but not in parent)
    const introduced = childDiff.structuredDifferences.filter((d) => !parentByRow.has(d.row));
    // Differences that changed type or instructions
    const changed: {
      row: number;
      before: (typeof parentDiff.structuredDifferences)[number];
      after: (typeof childDiff.structuredDifferences)[number];
    }[] = [];
    for (const d of childDiff.structuredDifferences) {
      const prev = parentByRow.get(d.row);
      if (prev && (prev.type !== d.type || prev.candidateInstruction !== d.candidateInstruction)) {
        changed.push({ row: d.row, before: prev, after: d });
      }
    }

    return c.json({
      candidateId: candidate.id,
      parentId: parent.id,
      scoreBefore: parent.score,
      scoreAfter: candidate.score,
      scoreDelta: parent.score - candidate.score,
      ruleId: candidate.ruleId ?? null,
      resolved,
      introduced,
      changed,
    });
  });

  app.get('/candidates/:id/assembly', async (c) => {
    const store = getStore();
    const candidate = store?.getCandidate(c.req.param('id'));
    if (!candidate) {
      return c.json({ error: 'Candidate not found' }, 404);
    }
    const result = await getSearch().getAssemblyDiff(candidate.source);
    if (result === null) {
      return c.json({ error: 'Compilation failed or function not found' }, 422);
    }
    return c.json(result);
  });

  app.get('/graph', (c) => {
    const store = getStore();
    const graph = store?.getGraph() ?? { candidates: [], mutationTargets: [] };
    return c.json({
      ...graph,
      candidates: graph.candidates.map((cand) => slice(cand, store)),
    });
  });

  app.get('/context-source', (c) => {
    const store = getStore();
    const source = store?.getContextSource();
    if (source === undefined) {
      return c.json({ present: false });
    }
    return c.json({ present: true, length: source.length, source });
  });

  app.get('/rules', (c) => {
    return c.json(getSearch().getRules());
  });

  app.get('/rules/history', (c) => {
    const store = getStore();
    return c.json(store?.getRuleStats() ?? []);
  });

  app.get('/rules/history/:branch_id', (c) => {
    const branchId = c.req.param('branch_id');
    const stats = getSearch().getBranchRuleHistory(branchId);
    if (stats === null) {
      return c.json({ error: `Branch '${branchId}' not found or adaptive selection is disabled` }, 404);
    }
    return c.json(stats);
  });

  app.get('/timeline', (c) => {
    const store = getStore();
    return c.json(store?.getScoreTimeline() ?? []);
  });

  app.get('/report', (c) => {
    const store = getStore();
    return c.json(store?.toJSON() ?? null);
  });

  app.get('/diff-summary', async (c) => {
    const store = getStore();
    const best = store?.getBestCandidate();
    if (!best) {
      return c.json(null, 404);
    }
    const result = await getSearch().getAssemblyDiff(best.source);
    if (!result) {
      return c.json({ error: 'Compilation failed or function not found' }, 422);
    }

    // Build suggestedRules: for each diff type with remaining > 0,
    // find rules that have historically fixed that type (deltaByType > 0).
    const breakdown = best.breakdown;
    const ruleStats = store?.getRuleStats() ?? [];
    const diffTypes = ['insert', 'delete', 'replace', 'opMismatch', 'argMismatch'] as const;
    const suggestedRules = diffTypes
      .filter((dt) => breakdown[dt] > 0)
      .map((dt) => {
        const bestRules = ruleStats
          .filter((r) => r.deltaByType[dt] > 0)
          .sort((a, b) => b.deltaByType[dt] - a.deltaByType[dt])
          .slice(0, 5)
          .map((r) => ({ ruleId: r.ruleId, deltaForType: r.deltaByType[dt] }));
        return { diffType: dt, remaining: breakdown[dt], bestRules };
      });

    return c.json({
      score: best.score,
      breakdown,
      structuredDifferences: result.structuredDifferences,
      differenceCount: result.differenceCount,
      matchingCount: result.matchingCount,
      suggestedRules,
    });
  });

  // -- Control operations --

  app.post('/pause', (c) => {
    getSearch().pause();
    return c.json({ ok: true });
  });

  app.post('/resume', (c) => {
    getSearch().resume();
    return c.json({ ok: true });
  });

  app.post('/stop', (c) => {
    getSearch().stop();
    return c.json({ ok: true });
  });

  app.post('/inject', async (c) => {
    const body = await c.req.json<{ source?: string; label?: string; dryRun?: boolean }>();
    if (typeof body.source !== 'string' || body.source.length === 0) {
      return c.json({ error: 'Missing or empty "source" field' }, 400);
    }

    const search = getSearch();

    // Always compile + diff so every response includes score/breakdown/diffs
    const diff = await search.getAssemblyDiff(body.source);
    if (!diff) {
      return c.json({ error: 'Compilation failed or function not found' }, 422);
    }

    const diffFields = {
      score: diff.differenceCount,
      structuredDifferences: diff.structuredDifferences,
      differenceCount: diff.differenceCount,
      matchingCount: diff.matchingCount,
      assembly: diff.assembly,
    };

    if (body.dryRun) {
      return c.json({ dryRun: true, ...diffFields });
    }

    const result = await search.injectCode(body.source, { label: body.label });
    if (!result) {
      return c.json({ error: 'Injection failed (compilation error or function not found)' }, 422);
    }
    return c.json({ ...result.candidate, target: result.target, ...diffFields });
  });

  // -- Prune --

  function executePrune(params: { maxScore?: number; keepBestN?: number }): { disabled: number; remaining: number } {
    const store = getStore();
    if (!store) {
      return { disabled: 0, remaining: 0 };
    }
    const graph = store.getGraph();
    const candidateMap = new Map(graph.candidates.map((cand) => [cand.id, cand]));
    const enabledTargets = graph.mutationTargets.filter((t) => t.enabled);
    let toDisable: string[] = [];

    if (typeof params.maxScore === 'number') {
      toDisable = enabledTargets
        .filter((t) => {
          const cand = candidateMap.get(t.candidateId);
          return cand && cand.score >= params.maxScore!;
        })
        .map((t) => t.id);
    } else if (typeof params.keepBestN === 'number') {
      const sorted = enabledTargets
        .map((t) => ({ target: t, score: candidateMap.get(t.candidateId)?.score ?? Infinity }))
        .sort((a, b) => a.score - b.score);
      toDisable = sorted.slice(params.keepBestN).map((s) => s.target.id);
    }

    for (const id of toDisable) {
      getSearch().disableBranch(id);
    }

    return { disabled: toDisable.length, remaining: enabledTargets.length - toDisable.length };
  }

  function executeCompact(): { removed: number; superNodes: number; candidatesAfter: number } {
    const search = getSearch();
    const result = search.summarize();
    getStore()?.summarize();
    const store = getStore();
    const candidatesAfter = store ? store.getGraph().candidates.length : 0;
    return { removed: result.removed, superNodes: result.superNodes.length, candidatesAfter };
  }

  app.post('/branches/prune', async (c) => {
    const body = await c.req.json<{ maxScore?: number; keepBestN?: number }>();
    if (typeof body.maxScore !== 'number' && typeof body.keepBestN !== 'number') {
      return c.json({ error: 'Provide "maxScore" or "keepBestN"' }, 400);
    }
    if (typeof body.keepBestN === 'number' && body.keepBestN < 1) {
      return c.json({ error: 'keepBestN must be at least 1' }, 400);
    }
    const pruneResult = executePrune(body);
    const compacted = executeCompact();
    return c.json({ ...pruneResult, compacted });
  });

  app.post('/branches/:id/weight', async (c) => {
    const body = await c.req.json<{ weight?: number }>();
    if (typeof body.weight !== 'number' || body.weight < 0) {
      return c.json({ error: 'Missing or invalid "weight" field (must be a non-negative number)' }, 400);
    }
    const id = c.req.param('id');
    if (!getSearch().setBranchWeight(id, body.weight)) {
      return c.json({ error: `Branch '${id}' not found` }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/branches/:id/disable', (c) => {
    const id = c.req.param('id');
    if (!getSearch().disableBranch(id)) {
      return c.json({ error: `Branch '${id}' not found` }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/branches/:id/enable', (c) => {
    const id = c.req.param('id');
    if (!getSearch().enableBranch(id)) {
      return c.json({ error: `Branch '${id}' not found` }, 404);
    }
    return c.json({ ok: true });
  });

  // -- Batch --

  interface BatchOperation {
    action: string;
    [key: string]: unknown;
  }

  async function executeBatchOp(op: BatchOperation): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const search = getSearch();
    switch (op.action) {
      case 'pause':
        search.pause();
        return { ok: true };
      case 'resume':
        search.resume();
        return { ok: true };
      case 'stop':
        search.stop();
        return { ok: true };
      case 'inject': {
        const source = op.source as string | undefined;
        if (typeof source !== 'string' || source.length === 0) {
          return { ok: false, error: 'Missing or empty "source"' };
        }
        const diff = await search.getAssemblyDiff(source);
        if (!diff) {
          return { ok: false, error: 'Compilation failed or function not found' };
        }
        const diffFields = {
          score: diff.differenceCount,
          structuredDifferences: diff.structuredDifferences,
          differenceCount: diff.differenceCount,
          matchingCount: diff.matchingCount,
          assembly: diff.assembly,
        };
        if (op.dryRun) {
          return { ok: true, data: { dryRun: true, ...diffFields } };
        }
        const result = await search.injectCode(source, { label: op.label as string | undefined });
        if (!result) {
          return { ok: false, error: 'Injection failed' };
        }
        return { ok: true, data: { ...result.candidate, target: result.target, ...diffFields } };
      }
      case 'set-branch-weight': {
        const weight = op.weight as number | undefined;
        const targetId = op.targetId as string | undefined;
        if (!targetId || typeof weight !== 'number' || weight < 0) {
          return { ok: false, error: 'Missing targetId or invalid weight' };
        }
        if (!search.setBranchWeight(targetId, weight)) {
          return { ok: false, error: `Branch '${targetId}' not found` };
        }
        return { ok: true };
      }
      case 'disable-branch': {
        const targetId = op.targetId as string | undefined;
        if (!targetId) {
          return { ok: false, error: 'Missing targetId' };
        }
        if (!search.disableBranch(targetId)) {
          return { ok: false, error: `Branch '${targetId}' not found` };
        }
        return { ok: true };
      }
      case 'enable-branch': {
        const targetId = op.targetId as string | undefined;
        if (!targetId) {
          return { ok: false, error: 'Missing targetId' };
        }
        if (!search.enableBranch(targetId)) {
          return { ok: false, error: `Branch '${targetId}' not found` };
        }
        return { ok: true };
      }
      case 'update-rule-weights': {
        const weights = op.weights as Record<string, number> | undefined;
        if (!weights || typeof weights !== 'object') {
          return { ok: false, error: 'Missing weights object' };
        }
        const unknown = search.updateWeights(weights);
        if (unknown.length > 0) {
          return { ok: false, error: `Unknown rule(s): ${unknown.join(', ')}` };
        }
        return { ok: true };
      }
      case 'enable-rule': {
        const ruleId = op.ruleId as string | undefined;
        if (!ruleId) {
          return { ok: false, error: 'Missing ruleId' };
        }
        if (!search.enableRule(ruleId)) {
          return { ok: false, error: `Rule '${ruleId}' not found` };
        }
        return { ok: true };
      }
      case 'disable-rule': {
        const ruleId = op.ruleId as string | undefined;
        if (!ruleId) {
          return { ok: false, error: 'Missing ruleId' };
        }
        if (!search.disableRule(ruleId)) {
          return { ok: false, error: `Rule '${ruleId}' not found` };
        }
        return { ok: true };
      }
      case 'prune': {
        const pruneParams = op as { maxScore?: number; keepBestN?: number };
        if (typeof pruneParams.keepBestN === 'number' && pruneParams.keepBestN < 1) {
          return { ok: false, error: 'keepBestN must be at least 1' };
        }
        const pruneResult = executePrune(pruneParams);
        const compacted = executeCompact();
        return { ok: true, data: { ...pruneResult, compacted } };
      }
      default:
        return { ok: false, error: `Unknown action: ${op.action}` };
    }
  }

  app.post('/batch', async (c) => {
    const body = await c.req.json<{ operations?: BatchOperation[] }>();
    if (!Array.isArray(body.operations) || body.operations.length === 0) {
      return c.json({ error: 'Body must have "operations" array with at least one entry' }, 400);
    }
    const results = [];
    for (const op of body.operations) {
      results.push(await executeBatchOp(op));
    }
    return c.json({ results });
  });

  // -- Rule operations --

  app.post('/rules/weights', async (c) => {
    const weights = await c.req.json<Record<string, number>>();
    if (typeof weights !== 'object' || weights === null) {
      return c.json({ error: 'Body must be a JSON object of { ruleId: weight }' }, 400);
    }
    // Validate: no negative weights
    for (const [id, w] of Object.entries(weights)) {
      if (typeof w !== 'number' || w < 0) {
        return c.json({ error: `Invalid weight for rule '${id}': must be a non-negative number` }, 400);
      }
    }
    const unknown = getSearch().updateWeights(weights);
    if (unknown.length > 0) {
      return c.json({ error: `Unknown rule(s): ${unknown.join(', ')}` }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/rules/:id/enable', (c) => {
    const id = c.req.param('id');
    if (!getSearch().enableRule(id)) {
      return c.json({ error: `Rule '${id}' not found` }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/rules/:id/disable', (c) => {
    const id = c.req.param('id');
    if (!getSearch().disableRule(id)) {
      return c.json({ error: `Rule '${id}' not found` }, 404);
    }
    return c.json({ ok: true });
  });

  // -- Focus constraints --

  app.get('/focus', (c) => {
    return c.json(getSearch().getFocusConstraints());
  });

  app.put('/focus', async (c) => {
    const body = await c.req.json<{
      focusRegions?: FocusRegionConstraint[];
      avoidRegions?: AvoidRegionConstraint[];
    }>();
    const focusRegions = body.focusRegions ?? [];
    const avoidRegions = body.avoidRegions ?? [];

    // Validate focus regions
    for (const r of focusRegions) {
      if (!r.id || !r.lines || typeof r.lines.start !== 'number' || typeof r.lines.end !== 'number') {
        return c.json({ error: 'Each focus region must have id, lines.start (number), and lines.end (number)' }, 400);
      }
      if (r.lines.start < 0 || r.lines.end < 0) {
        return c.json({ error: 'Line numbers must be non-negative' }, 400);
      }
      if (r.lines.start > r.lines.end) {
        return c.json({ error: 'lines.start must be <= lines.end' }, 400);
      }
    }
    // Validate avoid regions
    for (const r of avoidRegions) {
      if (!r.id || !r.lines || typeof r.lines.start !== 'number' || typeof r.lines.end !== 'number') {
        return c.json({ error: 'Each avoid region must have id, lines.start (number), and lines.end (number)' }, 400);
      }
      if (r.lines.start < 0 || r.lines.end < 0) {
        return c.json({ error: 'Line numbers must be non-negative' }, 400);
      }
      if (r.lines.start > r.lines.end) {
        return c.json({ error: 'lines.start must be <= lines.end' }, 400);
      }
    }

    // Normalize: ensure type fields are set
    const normalizedFocus: FocusRegionConstraint[] = focusRegions.map((r) => ({
      ...r,
      type: 'focus-region' as const,
      description: r.description ?? `Focus on lines ${r.lines.start}-${r.lines.end}`,
    }));
    const normalizedAvoid: AvoidRegionConstraint[] = avoidRegions.map((r) => ({
      ...r,
      type: 'avoid-region' as const,
      description: r.description ?? `Avoid lines ${r.lines.start}-${r.lines.end}`,
    }));

    getSearch().setFocusConstraints(normalizedFocus, normalizedAvoid);
    return c.json({ ok: true, focusRegions: normalizedFocus.length, avoidRegions: normalizedAvoid.length });
  });

  // -- Mutation depth --

  app.get('/mutation-depth', (c) => {
    return c.json({ depth: getSearch().getMutationDepth() });
  });

  app.put('/mutation-depth', async (c) => {
    const body = await c.req.json<{ depth: number }>();
    if (typeof body.depth !== 'number' || body.depth < 1 || !Number.isInteger(body.depth)) {
      return c.json({ error: 'depth must be a positive integer' }, 400);
    }
    getSearch().setMutationDepth(body.depth);
    return c.json({ ok: true, depth: body.depth });
  });
}

// ---------------------------------------------------------------------------
// Match app (transmuter match --api)
// ---------------------------------------------------------------------------

export function createMatchApp(search: MutationSearch, store: SessionStore): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof SyntaxError && err.message.includes('JSON')) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500);
  });

  app.get('/', (c) =>
    c.json({
      name: 'Transmuter Control API',
      mode: 'match',
      description:
        'JSON API for controlling and querying a running Transmuter permutation session. ' +
        'Read endpoints return session state; control endpoints mutate the running session.',
      endpoints: ALL_COMMON_ENDPOINTS,
    }),
  );

  registerSearchRoutes(app, {
    getSearch: () => search,
    getStore: () => store,
  });

  return app;
}

// ---------------------------------------------------------------------------
// Refine app (transmuter refine --api)
// ---------------------------------------------------------------------------

const REFINE_EXTRA_ENDPOINTS: EndpointDescription[] = [
  {
    method: 'GET',
    path: '/violations',
    description:
      'Current violations with their statuses: trivially-fixed, fixed, removal-failed, transmuter-exhausted. ' +
      'Each violation includes exploration stats (iterations, score, assembly diff) when available.',
  },
  {
    method: 'GET',
    path: '/violations/:id',
    description:
      'A specific violation by its id. Includes fixedSource, fixDiff, and exploration sub-session when available.',
  },
  {
    method: 'GET',
    path: '/violations/:id/sub-session',
    description:
      'The full SessionReport from the internal Transmuter sub-session for this violation. ' +
      'Contains the candidate graph, rule stats, timeline, etc. Returns null if no sub-session exists.',
  },
  {
    method: 'GET',
    path: '/active-sub-sessions',
    description:
      'List the currently active sub-sessions (violation IDs being explored right now). ' +
      'Empty between phases and after completion.',
  },
  {
    method: 'GET',
    path: '/merge',
    description:
      'Phase 2 merge state. Returns { completed: MergeLogEntry[], pending: PendingMerge[] }. ' +
      'completed lists merge steps that have already happened (step, violationId, action, optional diff). ' +
      'pending lists violations whose Phase 1 fix is ready (status: fixed | trivially-fixed) but has not yet been ' +
      'applied to the spine, including their fixedSource when available. Drains to empty after Phase 2 finishes.',
  },
  {
    method: 'GET',
    path: '/config',
    description: 'Refinement config: functionName, guidelineId, concurrency, maxCompilesPerViolation, etc.',
  },
];

export function createRefineApp(refiner: Refiner, refinementStore: RefinementStore): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof SyntaxError && err.message.includes('JSON')) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500);
  });

  app.get('/', (c) =>
    c.json({
      name: 'Transmuter Control API',
      mode: 'refine',
      description:
        'JSON API for querying and controlling a running Transmuter refinement session. ' +
        'All common search endpoints (candidates, branches, rules, inject, etc.) operate on ' +
        'the currently active sub-session. Refine-specific endpoints provide violation tracking.',
      endpoints: [...ALL_COMMON_ENDPOINTS, ...REFINE_EXTRA_ENDPOINTS],
    }),
  );

  // Helper: get the first active sub-session's SessionStore, or null
  function getActiveStore(): SessionStore | null {
    const subs = refiner.getActiveSubSessions();
    const first = subs.values().next().value as ActiveSubSession | undefined;
    return first?.store ?? null;
  }

  // -- Refine-specific read operations (registered BEFORE common routes to take precedence) --

  // /report returns the full refinement report, not the sub-session report
  app.get('/report', (c) => c.json(refinementStore.toJSON()));

  // /rules/history aggregates rule stats from both the refinement store
  // (completed sub-sessions) and the live active sub-sessions, so the endpoint
  // is useful during Phase 1 instead of staying empty until the first sub-session
  // report lands in the store.
  app.get('/rules/history', (c) => c.json(refiner.getRuleStats()));

  app.get('/violations', (c) => c.json(refinementStore.toJSON().violations));

  app.get('/violations/:id', (c) => {
    const id = c.req.param('id');
    const violation = refinementStore.toJSON().violations.find((v) => v.id === id);
    if (!violation) {
      return c.json({ error: `Violation '${id}' not found` }, 404);
    }
    return c.json(violation);
  });

  app.get('/violations/:id/sub-session', (c) => {
    const id = c.req.param('id');
    // First check active sub-sessions for live data
    const active = refiner.getActiveSubSessions().get(id);
    if (active) {
      return c.json(active.store.toJSON());
    }
    // Fall back to completed sub-session data from the store
    const violation = refinementStore.toJSON().violations.find((v) => v.id === id);
    if (!violation) {
      return c.json({ error: `Violation '${id}' not found` }, 404);
    }
    return c.json(violation.exploration?.subSession ?? null);
  });

  app.get('/active-sub-sessions', (c) => {
    const subs = refiner.getActiveSubSessions();
    const result = [...subs.entries()].map(([violationId, sub]) => {
      const state = sub.search.getState();
      const summary = sub.store.getSummary();
      return {
        violationId,
        state: {
          ...state,
          forkCount: summary?.forkCount ?? 0,
          totalCompiled: summary?.totalCompiled ?? 0,
          totalErrors: summary?.totalErrors ?? 0,
          totalDeduped: summary?.totalDeduped ?? 0,
        },
      };
    });
    return c.json(result);
  });

  app.get('/merge', (c) =>
    c.json({
      completed: refinementStore.getMergeLog(),
      pending: refinementStore.getPendingMerges(),
    }),
  );

  app.get('/config', (c) => c.json(refinementStore.toJSON().config));

  // Refine-specific /inject: same as common inject but also detects violations
  app.post('/inject', async (c) => {
    const body = await c.req.json<{ source?: string; label?: string; dryRun?: boolean }>();
    if (typeof body.source !== 'string' || body.source.length === 0) {
      return c.json({ error: 'Missing or empty "source" field' }, 400);
    }

    const diff = await refiner.getAssemblyDiff(body.source);
    if (!diff) {
      return c.json({ error: 'Compilation failed or function not found' }, 422);
    }

    const diffFields = {
      score: diff.differenceCount,
      structuredDifferences: diff.structuredDifferences,
      differenceCount: diff.differenceCount,
      matchingCount: diff.matchingCount,
      assembly: diff.assembly,
    };

    const violations = refiner.detectViolations(body.source);

    if (body.dryRun) {
      return c.json({ dryRun: true, ...diffFields, violations });
    }

    const result = await refiner.injectCode(body.source, { label: body.label });
    if (!result) {
      return c.json({ error: 'Injection failed (compilation error or function not found)' }, 422);
    }
    return c.json({ ...result.candidate, target: result.target, ...diffFields, violations });
  });

  // Register common routes AFTER refine-specific ones (Hono matches first registered)
  registerSearchRoutes(app, {
    getSearch: () => refiner,
    getStore: getActiveStore,
  });

  return app;
}

// ---------------------------------------------------------------------------
// Cleanup app (transmuter cleanup --api)
// ---------------------------------------------------------------------------

const CLEANUP_EXTRA_ENDPOINTS: EndpointDescription[] = [
  {
    method: 'GET',
    path: '/cleanup-state',
    description:
      'Current cleanup state. Returns which phase is active (phase1-canonicalize, phase2-smell-permutation, done) ' +
      'and progress information.',
  },
];

export function createCleanupApp(cleanup: Cleanup): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof SyntaxError && err.message.includes('JSON')) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500);
  });

  app.get('/', (c) =>
    c.json({
      name: 'Transmuter Control API',
      mode: 'cleanup',
      description:
        'JSON API for querying and controlling a running Transmuter cleanup session. ' +
        'Common search endpoints are available during Phase 2 (smell-budget permutation).',
      endpoints: [...ALL_COMMON_ENDPOINTS, ...CLEANUP_EXTRA_ENDPOINTS],
    }),
  );

  registerSearchRoutes(app, {
    getSearch: () => cleanup,
    getStore: () => cleanup.getActiveSearch()?.store ?? null,
  });

  app.get('/cleanup-state', (c) => {
    const active = cleanup.getActiveSearch();
    return c.json({
      phase: active ? 'phase2-smell-permutation' : 'idle',
      hasActiveSearch: active !== null,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Server creation (shared by all modes)
// ---------------------------------------------------------------------------

export async function createControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const { app, discoveryDir, sessionId, port: requestedPort } = options;

  const server = Bun.serve({
    fetch: app.fetch,
    port: requestedPort ?? 0,
    hostname: '127.0.0.1',
  });
  const actualPort = server.port!;

  const discoveryPath = path.join(discoveryDir, 'transmuter-control.json');
  const discovery: DiscoveryFile = {
    pid: process.pid,
    port: actualPort,
    sessionId,
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(discoveryPath, JSON.stringify(discovery, null, 2));

  async function close(): Promise<void> {
    await server.stop();
    try {
      await fs.unlink(discoveryPath);
    } catch {
      // Discovery file may already be gone
    }
  }

  return { port: actualPort, discoveryPath, close };
}
