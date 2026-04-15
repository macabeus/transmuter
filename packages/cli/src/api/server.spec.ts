import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ControlServer, createControlServer, createMatchApp, createRefineApp } from './server.js';

// ---------------------------------------------------------------------------
// Minimal mocks — we only need the shapes the server calls
// ---------------------------------------------------------------------------

function mockTransmuter() {
  return {
    getState: vi.fn().mockReturnValue({
      running: true,
      paused: false,
      iteration: 42,
      elapsed: 5000,
      bestScore: 80,
      bestSource: 'void foo() {}',
      targets: [],
      ruleWeights: {},
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    injectCode: vi.fn().mockResolvedValue({
      candidate: { id: 'c-1', score: 90 },
      target: { id: 't-1' },
    }),
    getAssemblyDiff: vi.fn().mockResolvedValue({
      assembly: 'ldr r0, [r1]',
      targetAssembly: 'ldr r0, [r1]',
      diff: '  ldr r0, [r1]    |   ldr r0, [r1]',
      differences: [],
      differenceCount: 0,
      matchingCount: 1,
    }),
    setBranchWeight: vi.fn().mockReturnValue(true),
    disableBranch: vi.fn().mockReturnValue(true),
    enableBranch: vi.fn().mockReturnValue(true),
    updateWeights: vi.fn().mockReturnValue([]),
    enableRule: vi.fn().mockReturnValue(true),
    disableRule: vi.fn().mockReturnValue(true),
    getRules: vi.fn().mockReturnValue([
      { ruleId: 'reorder-stmts', description: 'Reorder statements', weight: 10, enabled: true },
      { ruleId: 'delete-stmt', description: 'Delete a statement', weight: 5, enabled: true },
      { ruleId: 'cast-expr', description: 'Add type cast', weight: 0, enabled: false },
    ]),
    getBranchRuleHistory: vi.fn().mockReturnValue([{ ruleId: 'reorder-stmts', trials: 15, successRate: 0.2 }]),
    setFocusConstraints: vi.fn(),
    getFocusConstraints: vi.fn().mockReturnValue({ focusRegions: [], avoidRegions: [] }),
    setMutationDepth: vi.fn(),
    getMutationDepth: vi.fn().mockReturnValue(1),
    pruneTargets: vi.fn().mockReturnValue({ disabled: 0, remaining: 0 }),
    summarize: vi.fn().mockReturnValue({ removed: 0, superNodes: [], removedTargetIds: [] }),
  };
}

function mockStore() {
  return {
    getSummary: vi.fn().mockReturnValue({
      bestScore: 80,
      baseScore: 120,
      scoreDelta: 40,
      perfectMatch: false,
      totalIterations: 100,
      elapsed: 5000,
      totalCompiled: 80,
      totalErrors: 10,
      totalDeduped: 5,
      forkCount: 3,
      targetCount: 4,
      activeTargetCount: 3,
      avgForkInterval: 1666,
    }),
    getAllCandidates: vi.fn().mockReturnValue([
      { id: 'c-0', score: 80, origin: 'genesis', source: 'code0' },
      { id: 'c-1', score: 60, origin: 'organic', source: 'code1' },
      { id: 'c-2', score: 40, origin: 'organic', source: 'code2' },
      { id: 'c-3', score: 100, origin: 'external', source: 'code3' },
    ]),
    getBestCandidate: vi.fn().mockReturnValue({ id: 'c-2', score: 40, source: 'code2' }),
    getCandidate: vi.fn().mockReturnValue({ id: 'c-0', score: 80, source: 'code' }),
    getLineage: vi.fn().mockReturnValue([{ id: 'c-0', source: 'code' }]),
    getChildren: vi.fn().mockReturnValue([]),
    getGraph: vi.fn().mockReturnValue({
      candidates: [
        { id: 'c-0', score: 80, source: 'code0' },
        { id: 'c-1', score: 60, source: 'code1' },
        { id: 'c-2', score: 40, source: 'code2' },
      ],
      mutationTargets: [
        { id: 't-0', candidateId: 'c-0', enabled: true },
        { id: 't-1', candidateId: 'c-1', enabled: true },
        { id: 't-2', candidateId: 'c-2', enabled: true },
      ],
    }),
    getFunctionName: vi.fn().mockReturnValue(''),
    getContextSource: vi.fn().mockReturnValue(undefined),
    getRuleStats: vi.fn().mockReturnValue([]),
    getScoreTimeline: vi.fn().mockReturnValue([]),
    getFocusResults: vi.fn().mockReturnValue([]),
    summarize: vi.fn(),
    toJSON: vi.fn().mockReturnValue({
      version: 1,
      type: 'match',
      metadata: { sessionId: 'test-session' },
    }),
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlServer', () => {
  let server: ControlServer;
  let transmuter: ReturnType<typeof mockTransmuter>;
  let store: ReturnType<typeof mockStore>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transmuter-api-test-'));
    transmuter = mockTransmuter();
    store = mockStore();

    const app = createMatchApp(transmuter as any, store as any);
    server = await createControlServer({
      app,
      discoveryDir: tmpDir,
      sessionId: 'test-session',
    });
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a discovery file on startup', async () => {
    const raw = await fs.readFile(server.discoveryPath, 'utf-8');
    const discovery = JSON.parse(raw);
    expect(discovery.pid).toBe(process.pid);
    expect(discovery.port).toBe(server.port);
    expect(discovery.sessionId).toBe('test-session');
  });

  it('removes the discovery file on close', async () => {
    await server.close();
    await expect(fs.access(server.discoveryPath)).rejects.toThrow();
  });

  // -- API description --

  it('GET / returns API description with all endpoints', async () => {
    const { status, data } = await request(server.port, 'GET', '/');
    expect(status).toBe(200);
    const body = data as { name: string; endpoints: { method: string; path: string; description: string }[] };
    expect(body.name).toBe('Transmuter Control API');
    expect(body.endpoints.length).toBeGreaterThan(0);
    for (const ep of body.endpoints) {
      expect(typeof ep.method).toBe('string');
      expect(typeof ep.path).toBe('string');
      expect(ep.description.length).toBeGreaterThan(0);
    }
    const paths = body.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /session');
    expect(paths).toContain('POST /inject');
    expect(paths).toContain('POST /batch');
    expect(paths).toContain('POST /branches/prune');
    expect(paths).toContain('GET /candidates/:id/assembly');
  });

  // -- Session endpoint --

  it('GET /session returns session snapshot', async () => {
    const { status, data } = await request(server.port, 'GET', '/session');
    expect(status).toBe(200);
    const session = data as Record<string, unknown>;
    // From getState
    expect(session.running).toBe(true);
    expect(session.paused).toBe(false);
    expect(session.bestSource).toBe('void foo() {}');
    expect(session.ruleWeights).toEqual({});
    // From getSummary
    expect(session.baseScore).toBe(120);
    expect(session.bestScore).toBe(80);
    expect(session.forkCount).toBe(3);
    expect(session.totalCompiled).toBe(80);
  });

  // -- Read endpoints --

  it('GET /candidates returns candidates array', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(4);
  });

  it('GET /candidates?maxScore=70 filters by max score', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates?maxScore=70');
    expect(status).toBe(200);
    const candidates = data as { score: number }[];
    expect(candidates.every((c) => c.score <= 70)).toBe(true);
    expect(candidates.length).toBe(2); // scores 40 and 60
  });

  it('GET /candidates?minScore=70 filters by min score', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates?minScore=70');
    expect(status).toBe(200);
    const candidates = data as { score: number }[];
    expect(candidates.every((c) => c.score >= 70)).toBe(true);
    expect(candidates.length).toBe(2); // scores 80 and 100
  });

  it('GET /candidates?origin=external filters by origin', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates?origin=external');
    expect(status).toBe(200);
    const candidates = data as { origin: string }[];
    expect(candidates.every((c) => c.origin === 'external')).toBe(true);
    expect(candidates.length).toBe(1);
  });

  it('GET /candidates?limit=2 limits results', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates?limit=2');
    expect(status).toBe(200);
    const candidates = data as unknown[];
    expect(candidates.length).toBe(2);
  });

  it('GET /candidates returns sorted by score ascending', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates');
    expect(status).toBe(200);
    const scores = (data as { score: number }[]).map((c) => c.score);
    expect(scores).toEqual([40, 60, 80, 100]);
  });

  it('GET /candidates/best returns best candidate', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates/best');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ id: 'c-2', score: 40 }));
  });

  it('GET /candidates/:id returns a specific candidate', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates/c-0');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ id: 'c-0' }));
    expect(store.getCandidate).toHaveBeenCalledWith('c-0');
  });

  it('GET /candidates/:id/lineage returns lineage', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates/c-0/lineage');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /candidates/:id/children returns children', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates/c-0/children');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /candidates/:id/assembly returns assembly data', async () => {
    const { status, data } = await request(server.port, 'GET', '/candidates/c-0/assembly');
    expect(status).toBe(200);
    const result = data as { assembly: string; targetAssembly: string; diff: string; differenceCount: number };
    expect(result.assembly).toBe('ldr r0, [r1]');
    expect(result.diff).toContain('ldr r0');
    expect(result.differenceCount).toBe(0);
    expect(transmuter.getAssemblyDiff).toHaveBeenCalledWith('code');
  });

  it('GET /candidates/:id/assembly returns 404 for unknown candidate', async () => {
    store.getCandidate.mockReturnValueOnce(undefined);
    const { status } = await request(server.port, 'GET', '/candidates/nonexistent/assembly');
    expect(status).toBe(404);
  });

  it('GET /candidates/:id/assembly returns 422 when compilation fails', async () => {
    transmuter.getAssemblyDiff.mockResolvedValueOnce(null);
    const { status } = await request(server.port, 'GET', '/candidates/c-0/assembly');
    expect(status).toBe(422);
  });

  it('GET /graph returns the graph', async () => {
    const { status, data } = await request(server.port, 'GET', '/graph');
    expect(status).toBe(200);
    const graph = data as { candidates: unknown[]; mutationTargets: unknown[] };
    expect(graph.candidates.length).toBe(3);
  });

  // -- Candidate source slicing --

  it('slices candidate sources to the target function when functionName is set', async () => {
    const full = [
      'typedef int u32;',
      'int other(void) { return 1; }',
      'int target(int x) { return x * 2; }',
      'int trailing(void) { return 0; }',
    ].join('\n');
    store.getFunctionName.mockReturnValue('target');
    store.getCandidate.mockReturnValueOnce({ id: 'c-0', score: 80, source: full });

    const { status, data } = await request(server.port, 'GET', '/candidates/c-0');
    expect(status).toBe(200);
    expect((data as { source: string }).source).toBe('int target(int x) { return x * 2; }');
  });

  it('leaves sources untouched when no functionName is configured', async () => {
    store.getFunctionName.mockReturnValue('');
    store.getCandidate.mockReturnValueOnce({ id: 'c-0', score: 80, source: 'arbitrary text' });

    const { data } = await request(server.port, 'GET', '/candidates/c-0');
    expect((data as { source: string }).source).toBe('arbitrary text');
  });

  // -- Context source --

  it('GET /context-source returns { present: false } when isolation was not used', async () => {
    const { status, data } = await request(server.port, 'GET', '/context-source');
    expect(status).toBe(200);
    expect(data).toEqual({ present: false });
  });

  it('GET /context-source returns the full source when isolation was used', async () => {
    const ctx = '/* full pre-isolation TU */\nint target(void) { return 0; }';
    store.getContextSource.mockReturnValue(ctx);
    const { status, data } = await request(server.port, 'GET', '/context-source');
    expect(status).toBe(200);
    expect(data).toEqual({ present: true, length: ctx.length, source: ctx });
  });

  it('documents /context-source on GET /', async () => {
    const { data } = await request(server.port, 'GET', '/');
    const body = data as { endpoints: { method: string; path: string; description: string }[] };
    const entry = body.endpoints.find((e) => e.method === 'GET' && e.path === '/context-source');
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/pre-isolation/i);
  });

  it('GET /rules returns rule catalog', async () => {
    const { status, data } = await request(server.port, 'GET', '/rules');
    expect(status).toBe(200);
    const rules = data as { ruleId: string; description: string; weight: number; enabled: boolean }[];
    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ ruleId: 'reorder-stmts', description: 'Reorder statements', weight: 10, enabled: true });
    expect(rules[2]).toEqual({ ruleId: 'cast-expr', description: 'Add type cast', weight: 0, enabled: false });
  });

  it('GET /rules/history returns aggregate stats', async () => {
    const { status, data } = await request(server.port, 'GET', '/rules/history');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(store.getRuleStats).toHaveBeenCalled();
  });

  it('GET /rules/history/:branch_id returns per-branch stats', async () => {
    const { status, data } = await request(server.port, 'GET', '/rules/history/target-0');
    expect(status).toBe(200);
    const stats = data as { ruleId: string; trials: number; successRate: number }[];
    expect(stats).toHaveLength(1);
    expect(stats[0]!.ruleId).toBe('reorder-stmts');
    expect(transmuter.getBranchRuleHistory).toHaveBeenCalledWith('target-0');
  });

  it('GET /rules/history/:branch_id returns 404 for unknown branch', async () => {
    transmuter.getBranchRuleHistory.mockReturnValueOnce(null);
    const { status } = await request(server.port, 'GET', '/rules/history/nonexistent');
    expect(status).toBe(404);
  });

  it('GET /timeline returns score timeline', async () => {
    const { status, data } = await request(server.port, 'GET', '/timeline');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /report returns full report', async () => {
    const { status, data } = await request(server.port, 'GET', '/report');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ version: 1, type: 'match' }));
  });

  // -- Control endpoints --

  it('POST /pause calls transmuter.pause()', async () => {
    const { status, data } = await request(server.port, 'POST', '/pause');
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(transmuter.pause).toHaveBeenCalled();
  });

  it('POST /resume calls transmuter.resume()', async () => {
    const { status, data } = await request(server.port, 'POST', '/resume');
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
  });

  it('POST /stop calls transmuter.stop()', async () => {
    const { status, data } = await request(server.port, 'POST', '/stop');
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(transmuter.stop).toHaveBeenCalled();
  });

  it('POST /inject injects code', async () => {
    const { status, data } = await request(server.port, 'POST', '/inject', {
      source: 'void foo() { int a = 1; }',
      label: 'test',
    });
    expect(status).toBe(200);
    expect(data).toEqual(
      expect.objectContaining({
        id: 'c-1',
        target: expect.objectContaining({ id: 't-1' }),
      }),
    );
  });

  it('POST /inject returns 400 if source is missing', async () => {
    const { status } = await request(server.port, 'POST', '/inject', {});
    expect(status).toBe(400);
  });

  it('POST /inject returns 422 if injection fails', async () => {
    transmuter.injectCode.mockResolvedValue(null);
    const { status } = await request(server.port, 'POST', '/inject', { source: 'bad code' });
    expect(status).toBe(422);
  });

  // -- Prune --

  it('POST /branches/prune by maxScore disables branches', async () => {
    const { status, data } = await request(server.port, 'POST', '/branches/prune', { maxScore: 70 });
    expect(status).toBe(200);
    const result = data as { disabled: number; remaining: number };
    // Targets with scores 80 (c-0) should be disabled; 60 (c-1) and 40 (c-2) kept
    expect(result.disabled).toBe(1);
    expect(result.remaining).toBe(2);
    expect(transmuter.disableBranch).toHaveBeenCalledWith('t-0');
  });

  it('POST /branches/prune by keepBestN keeps only N best', async () => {
    const { status, data } = await request(server.port, 'POST', '/branches/prune', { keepBestN: 1 });
    expect(status).toBe(200);
    const result = data as { disabled: number; remaining: number };
    expect(result.disabled).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it('POST /branches/prune returns 400 without params', async () => {
    const { status } = await request(server.port, 'POST', '/branches/prune', {});
    expect(status).toBe(400);
  });

  it('POST /branches/prune returns 400 for keepBestN=0', async () => {
    const { status, data } = await request(server.port, 'POST', '/branches/prune', { keepBestN: 0 });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toBe('keepBestN must be at least 1');
  });

  it('POST /branches/prune returns 400 for negative keepBestN', async () => {
    const { status } = await request(server.port, 'POST', '/branches/prune', { keepBestN: -5 });
    expect(status).toBe(400);
  });

  // -- Branch operations --

  it('POST /branches/:id/weight sets branch weight', async () => {
    const { status } = await request(server.port, 'POST', '/branches/target-0/weight', { weight: 5 });
    expect(status).toBe(200);
    expect(transmuter.setBranchWeight).toHaveBeenCalledWith('target-0', 5);
  });

  it('POST /branches/:id/disable disables branch', async () => {
    const { status } = await request(server.port, 'POST', '/branches/target-0/disable');
    expect(status).toBe(200);
    expect(transmuter.disableBranch).toHaveBeenCalledWith('target-0');
  });

  it('POST /branches/:id/enable enables branch', async () => {
    const { status } = await request(server.port, 'POST', '/branches/target-0/enable');
    expect(status).toBe(200);
    expect(transmuter.enableBranch).toHaveBeenCalledWith('target-0');
  });

  // -- Batch --

  it('POST /batch executes multiple operations', async () => {
    const { status, data } = await request(server.port, 'POST', '/batch', {
      operations: [
        { action: 'pause' },
        { action: 'update-rule-weights', weights: { 'asm-barrier': 30 } },
        { action: 'disable-branch', targetId: 'target-0' },
        { action: 'resume' },
      ],
    });
    expect(status).toBe(200);
    const result = data as { results: { ok: boolean }[] };
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(transmuter.pause).toHaveBeenCalled();
    expect(transmuter.updateWeights).toHaveBeenCalledWith({ 'asm-barrier': 30 });
    expect(transmuter.disableBranch).toHaveBeenCalledWith('target-0');
    expect(transmuter.resume).toHaveBeenCalled();
  });

  it('POST /batch with inject returns data', async () => {
    const { status, data } = await request(server.port, 'POST', '/batch', {
      operations: [{ action: 'inject', source: 'void foo() {}', label: 'test' }],
    });
    expect(status).toBe(200);
    const result = data as { results: { ok: boolean; data?: unknown }[] };
    expect(result.results[0]!.ok).toBe(true);
    expect(result.results[0]!.data).toBeDefined();
  });

  it('POST /batch with prune returns disabled count', async () => {
    const { status, data } = await request(server.port, 'POST', '/batch', {
      operations: [{ action: 'prune', maxScore: 70 }],
    });
    expect(status).toBe(200);
    const result = data as { results: { ok: boolean; data?: { disabled: number } }[] };
    expect(result.results[0]!.data!.disabled).toBe(1);
  });

  it('POST /batch reports errors per-operation', async () => {
    const { status, data } = await request(server.port, 'POST', '/batch', {
      operations: [{ action: 'unknown-action' }, { action: 'pause' }],
    });
    expect(status).toBe(200);
    const result = data as { results: { ok: boolean; error?: string }[] };
    expect(result.results[0]!.ok).toBe(false);
    expect(result.results[0]!.error).toContain('Unknown action');
    expect(result.results[1]!.ok).toBe(true);
  });

  it('POST /batch returns 400 for empty operations', async () => {
    const { status } = await request(server.port, 'POST', '/batch', { operations: [] });
    expect(status).toBe(400);
  });

  // -- Rule operations --

  it('POST /rules/weights updates rule weights', async () => {
    const { status } = await request(server.port, 'POST', '/rules/weights', { 'asm-barrier': 30 });
    expect(status).toBe(200);
    expect(transmuter.updateWeights).toHaveBeenCalledWith({ 'asm-barrier': 30 });
  });

  it('POST /rules/:id/enable enables a rule', async () => {
    const { status } = await request(server.port, 'POST', '/rules/asm-barrier/enable');
    expect(status).toBe(200);
    expect(transmuter.enableRule).toHaveBeenCalledWith('asm-barrier');
  });

  it('POST /rules/:id/disable disables a rule', async () => {
    const { status } = await request(server.port, 'POST', '/rules/asm-barrier/disable');
    expect(status).toBe(200);
    expect(transmuter.disableRule).toHaveBeenCalledWith('asm-barrier');
  });

  // -- Focus constraints --

  it('GET /focus returns current constraints', async () => {
    const { status, data } = await request(server.port, 'GET', '/focus');
    expect(status).toBe(200);
    const body = data as { focusRegions: unknown[]; avoidRegions: unknown[] };
    expect(body).toHaveProperty('focusRegions');
    expect(body).toHaveProperty('avoidRegions');
    expect(transmuter.getFocusConstraints).toHaveBeenCalled();
  });

  it('PUT /focus accepts valid focus regions and calls setFocusConstraints', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ id: 'loop-body', lines: { start: 10, end: 25 } }],
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, focusRegions: 1, avoidRegions: 0 });
    expect(transmuter.setFocusConstraints).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'focus-region', id: 'loop-body', lines: { start: 10, end: 25 } })],
      [],
    );
  });

  it('PUT /focus accepts valid avoid regions and calls setFocusConstraints', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {
      avoidRegions: [{ id: 'header', lines: { start: 1, end: 5 } }],
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, focusRegions: 0, avoidRegions: 1 });
    expect(transmuter.setFocusConstraints).toHaveBeenCalledWith(
      [],
      [expect.objectContaining({ type: 'avoid-region', id: 'header', lines: { start: 1, end: 5 } })],
    );
  });

  it('PUT /focus accepts combined focus + avoid regions', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ id: 'ok', lines: { start: 1, end: 10 } }],
      avoidRegions: [{ id: 'ok2', lines: { start: 20, end: 30 } }],
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, focusRegions: 1, avoidRegions: 1 });
    expect(transmuter.setFocusConstraints).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'ok', type: 'focus-region' })],
      [expect.objectContaining({ id: 'ok2', type: 'avoid-region' })],
    );
  });

  it('PUT /focus with empty body clears all constraints', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {});
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, focusRegions: 0, avoidRegions: 0 });
    expect(transmuter.setFocusConstraints).toHaveBeenCalledWith([], []);
  });

  it('PUT /focus normalizes missing type and description fields', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ id: 'r1', lines: { start: 5, end: 15 } }],
      avoidRegions: [{ id: 'r2', lines: { start: 20, end: 30 } }],
    });
    expect(status).toBe(200);
    const [focusArg, avoidArg] = transmuter.setFocusConstraints.mock.calls[0]!;
    expect(focusArg[0]).toMatchObject({ type: 'focus-region', description: expect.stringContaining('5') });
    expect(avoidArg[0]).toMatchObject({ type: 'avoid-region', description: expect.stringContaining('20') });
  });

  it('PUT /focus rejects negative focus region line numbers', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ id: 'bad', lines: { start: -1, end: 5 } }],
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toMatch(/line/i);
  });

  it('PUT /focus rejects focus region start > end', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ id: 'bad', lines: { start: 20, end: 5 } }],
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toMatch(/start.*end|end.*start/i);
  });

  it('PUT /focus rejects negative avoid region line numbers', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      avoidRegions: [{ id: 'bad', lines: { start: 1, end: -3 } }],
    });
    expect(status).toBe(400);
  });

  it('PUT /focus rejects avoid region start > end', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      avoidRegions: [{ id: 'bad', lines: { start: 10, end: 2 } }],
    });
    expect(status).toBe(400);
  });

  it('PUT /focus rejects focus region missing id', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ lines: { start: 1, end: 5 } }],
    });
    expect(status).toBe(400);
  });

  it('PUT /focus rejects focus region missing lines', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [{ id: 'bad' }],
    });
    expect(status).toBe(400);
  });

  it('PUT /focus rejects avoid region missing id', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      avoidRegions: [{ lines: { start: 1, end: 5 } }],
    });
    expect(status).toBe(400);
  });

  it('PUT /focus accepts multiple focus regions at once', async () => {
    const { status, data } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [
        { id: 'r1', lines: { start: 1, end: 10 } },
        { id: 'r2', lines: { start: 20, end: 30 } },
        { id: 'r3', lines: { start: 40, end: 50 } },
      ],
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, focusRegions: 3, avoidRegions: 0 });
  });

  it('PUT /focus rejects if any region in a batch is invalid', async () => {
    const { status } = await request(server.port, 'PUT', '/focus', {
      focusRegions: [
        { id: 'good', lines: { start: 1, end: 10 } },
        { id: 'bad', lines: { start: 20, end: 5 } },
      ],
    });
    expect(status).toBe(400);
    expect(transmuter.setFocusConstraints).not.toHaveBeenCalled();
  });

  // -- Error handling --

  it('returns 404 for unknown routes', async () => {
    const { status } = await request(server.port, 'GET', '/nonexistent');
    expect(status).toBe(404);
  });

  it('returns 400 for invalid JSON body', async () => {
    const { status } = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/inject',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': 12 },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write('not valid js');
      req.end();
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Refine server tests
// ---------------------------------------------------------------------------

function mockRefiner() {
  return {
    stop: vi.fn(),
    getStore: vi.fn(),
    getActiveSubSessions: vi.fn().mockReturnValue(new Map()),
    pause: vi.fn(),
    resume: vi.fn(),
    injectCode: vi.fn().mockResolvedValue(null),
    detectViolations: vi.fn().mockReturnValue([]),
    getAssemblyDiff: vi.fn().mockResolvedValue(null),
    setBranchWeight: vi.fn().mockReturnValue(true),
    disableBranch: vi.fn().mockReturnValue(true),
    enableBranch: vi.fn().mockReturnValue(true),
    updateWeights: vi.fn().mockReturnValue([]),
    enableRule: vi.fn().mockReturnValue(true),
    disableRule: vi.fn().mockReturnValue(true),
    getRules: vi.fn().mockReturnValue([]),
    getRuleStats: vi.fn().mockReturnValue([{ ruleId: 'reorder-stmts', applied: 50, forked: 3 }]),
    getBranchRuleHistory: vi.fn().mockReturnValue(null),
    setFocusConstraints: vi.fn(),
    getFocusConstraints: vi.fn().mockReturnValue({ focusRegions: [], avoidRegions: [] }),
    setMutationDepth: vi.fn(),
    getMutationDepth: vi.fn().mockReturnValue(1),
    pruneTargets: vi.fn().mockReturnValue({ disabled: 0, remaining: 0 }),
    summarize: vi.fn().mockReturnValue({ removed: 0, superNodes: [], removedTargetIds: [] }),
    getState: vi.fn().mockReturnValue({
      running: false,
      paused: false,
      iteration: 0,
      elapsed: 0,
      bestScore: -1,
      bestSource: '',
      targets: [],
      ruleWeights: {},
    }),
  };
}

function mockRefinementStore() {
  return {
    toJSON: vi.fn().mockReturnValue({
      version: 1,
      type: 'refinement',
      metadata: { sessionId: 'refine-test' },
      config: { functionName: 'Foo', guidelineId: 'no-asm-pin', concurrency: 2 },
      guideline: { id: 'no-asm-pin', description: 'Remove asm pins' },
      violations: [
        { id: 'v-1', description: 'asm pin at line 3', status: 'fixed', exploration: { subSession: { version: 1 } } },
        { id: 'v-2', description: 'asm pin at line 7', status: 'transmuter-exhausted' },
      ],
      mergeLog: [{ step: 1, violationId: 'v-1', action: 'applied-trivially' }],
      finalResult: { source: 'void Foo() {}', violationsFixed: 1, violationsTotal: 2 },
      ruleStats: [{ ruleId: 'reorder-stmts', applied: 50, forked: 3 }],
    }),
    getMergeLog: vi.fn().mockReturnValue([{ step: 1, violationId: 'v-1', action: 'applied-trivially' }]),
    getPendingMerges: vi
      .fn()
      .mockReturnValue([{ violationId: 'v-3', status: 'trivially-fixed', fixedSource: 'void Foo() { /* fixed */ }' }]),
  };
}

describe('ControlServer (refine)', () => {
  let server: ControlServer;
  let refiner: ReturnType<typeof mockRefiner>;
  let refineStore: ReturnType<typeof mockRefinementStore>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transmuter-refine-api-test-'));
    refiner = mockRefiner();
    refineStore = mockRefinementStore();

    const app = createRefineApp(refiner as any, refineStore as any);
    server = await createControlServer({
      app,
      discoveryDir: tmpDir,
      sessionId: 'refine-test',
    });
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('GET / returns refine API description', async () => {
    const { status, data } = await request(server.port, 'GET', '/');
    expect(status).toBe(200);
    const body = data as { mode: string; endpoints: { method: string; path: string }[] };
    expect(body.mode).toBe('refine');
    expect(body.endpoints.length).toBeGreaterThan(0);
  });

  it('GET /report returns full RefinementReport', async () => {
    const { status, data } = await request(server.port, 'GET', '/report');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ version: 1, type: 'refinement' }));
  });

  it('GET /violations returns violations array', async () => {
    const { status, data } = await request(server.port, 'GET', '/violations');
    expect(status).toBe(200);
    expect((data as unknown[]).length).toBe(2);
  });

  it('GET /violations/:id returns a specific violation', async () => {
    const { status, data } = await request(server.port, 'GET', '/violations/v-1');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ id: 'v-1', status: 'fixed' }));
  });

  it('GET /violations/:id returns 404 for unknown id', async () => {
    const { status, data } = await request(server.port, 'GET', '/violations/nonexistent');
    expect(status).toBe(404);
    expect(data).toEqual(expect.objectContaining({ error: expect.stringContaining('not found') }));
  });

  it('GET /violations/:id/sub-session returns the sub-session', async () => {
    const { status, data } = await request(server.port, 'GET', '/violations/v-1/sub-session');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ version: 1 }));
  });

  it('GET /violations/:id/sub-session returns null when no sub-session', async () => {
    const { status, data } = await request(server.port, 'GET', '/violations/v-2/sub-session');
    expect(status).toBe(200);
    expect(data).toBeNull();
  });

  it('GET /merge returns { completed, pending } from the refinement store', async () => {
    const { status, data } = await request(server.port, 'GET', '/merge');
    expect(status).toBe(200);
    const body = data as {
      completed: { step: number; violationId: string; action: string }[];
      pending: { violationId: string; status: string; fixedSource?: string }[];
    };
    expect(body.completed).toHaveLength(1);
    expect(body.completed[0]).toEqual(
      expect.objectContaining({ step: 1, violationId: 'v-1', action: 'applied-trivially' }),
    );
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toEqual({
      violationId: 'v-3',
      status: 'trivially-fixed',
      fixedSource: 'void Foo() { /* fixed */ }',
    });
    expect(refineStore.getMergeLog).toHaveBeenCalled();
    expect(refineStore.getPendingMerges).toHaveBeenCalled();
  });

  it('GET /merge-log is no longer registered (replaced by /merge)', async () => {
    const { status } = await request(server.port, 'GET', '/merge-log');
    expect(status).toBe(404);
  });

  it('GET /rules/history calls refiner.getRuleStats() (live + completed)', async () => {
    const { status, data } = await request(server.port, 'GET', '/rules/history');
    expect(status).toBe(200);
    expect((data as { ruleId: string }[])[0]!.ruleId).toBe('reorder-stmts');
    // Must NOT read from refinementStore.toJSON().ruleStats anymore — that path
    // is empty during Phase 1, which is the bug this change fixes.
    expect(refiner.getRuleStats).toHaveBeenCalled();
  });

  it('GET /config returns refinement config', async () => {
    const { status, data } = await request(server.port, 'GET', '/config');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ functionName: 'Foo', guidelineId: 'no-asm-pin' }));
  });

  it('POST /stop calls refiner.stop()', async () => {
    const { status, data } = await request(server.port, 'POST', '/stop');
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(refiner.stop).toHaveBeenCalled();
  });
});
