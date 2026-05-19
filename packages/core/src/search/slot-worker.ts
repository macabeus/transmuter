/// <reference lib="webworker" />
/**
 * Slot worker entry point. Runs the mutate → dedup → compile → score pipeline
 * for one slot in its own Bun Worker thread. Main thread is the SlotOrchestrator;
 * this worker never touches the Pool or SessionStore.
 *
 * Lifecycle:
 *   1. Main posts {kind:'init'} → we build engine/compiler/scorer/deduplicator,
 *      register rules, seed adaptive stats, then reply {kind:'ready'}.
 *   2. Main posts {kind:'job'} repeatedly → we run one iteration and reply with
 *      a {kind: 'no-mutation' | 'dedup' | 'compile-error' | 'scored'} result.
 *   3. Main may post control messages (rules-updated, adaptive-snapshot,
 *      focus-updated, mutation-depth-updated) at any time; we update state and
 *      keep processing jobs.
 *   4. Main posts {kind:'shutdown'} → we abort in-flight compile, destroy the
 *      compiler (kills child subprocesses), and return. Main calls worker.unref()
 *      so the host process can exit even if we're still finalizing — see
 *      slot-orchestrator.#shutdown for why we don't use Worker.terminate() or
 *      process.exit() here.
 *
 * Module resolution note: this file lives inside @transmuter/core and imports
 * core internals via ~ alias + relative paths, so the Bun Worker constructor
 * must point at the built slot-worker.js (shipped as a separate bundler entry
 * — see `packages/core/build.ts`).
 */
import { Compiler } from '~/compiler/compiler.js';
import { clearParseCache, ensureLanguageRegistered } from '~/parser.js';
import { Deduplicator } from '~/pipeline/deduplicator.js';
import { Rng } from '~/rng.js';
import { AdaptiveSelector } from '~/rules/adaptive-selector.js';
import { builtInRules } from '~/rules/built-in/index.js';
import { MutationEngine, PROFILE_STATS } from '~/rules/engine.js';
import { RuleRegistry } from '~/rules/registry.js';
import { Scorer } from '~/scoring/scorer.js';

import type {
  PhaseTimings,
  WorkerInbound,
  WorkerInit,
  WorkerJob,
  WorkerOutbound,
  WorkerResult,
} from './worker-protocol.js';

interface WorkerState {
  slotId: number;
  engine: MutationEngine;
  compiler: Compiler;
  scorer: Scorer;
  deduplicator: Deduplicator;
  functionName: string;
  mutationDepth: number;
  registry: RuleRegistry;
  adaptive: AdaptiveSelector;
  abortController: AbortController;
}

let state: WorkerState | null = null;

self.onmessage = async (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case 'init':
        await handleInit(msg);
        return;

      case 'job':
        if (!state) {
          throw new Error('worker received job before init');
        }
        await handleJob(msg, state);
        return;

      case 'rules-updated':
        if (!state) {
          throw new Error('worker received rules-updated before init');
        }
        applyRules(state.registry, msg.enabledRuleIds, msg.ruleWeights);
        return;

      case 'adaptive-snapshot':
        if (!state) {
          throw new Error('worker received adaptive-snapshot before init');
        }
        state.adaptive.restore(msg.snapshot);
        return;

      case 'focus-updated':
        if (!state) {
          throw new Error('worker received focus-updated before init');
        }
        state.engine.setFocusConstraints([...msg.focusRegions], [...msg.avoidRegions]);
        return;

      case 'mutation-depth-updated':
        if (!state) {
          throw new Error('worker received mutation-depth-updated before init');
        }
        state.mutationDepth = msg.depth;
        return;

      case 'shutdown':
        if (state) {
          state.abortController.abort();
          await state.compiler.destroy();
          clearParseCache();
        }
        // Don't self-exit — main has unref'd this worker and will exit on
        // its own. process.exit() from a Bun Worker can race with native
        // module cleanup and SIGILL the main process.
        return;
    }
  } catch (err) {
    // Include the originating jobId on job-time errors so the orchestrator
    // can clear that job's inflight entry and free its prefetch slot.
    // Without this, repeated job-time throws starve the slot of work because
    // slot.pending never decrements past errors.
    post({
      kind: 'error',
      slotId: state?.slotId ?? -1,
      jobId: msg.kind === 'job' ? msg.jobId : undefined,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      fatal: msg.kind === 'init',
    });
  }
};

self.onerror = (event: ErrorEvent) => {
  post({
    kind: 'error',
    slotId: state?.slotId ?? -1,
    error: event.message,
    fatal: true,
  });
};

async function handleInit(msg: WorkerInit): Promise<void> {
  const t0 = performance.now();
  ensureLanguageRegistered(msg.language);

  const registry = new RuleRegistry();
  registry.registerAll(builtInRules);
  applyRules(registry, msg.enabledRuleIds, msg.ruleWeights);

  const adaptive = new AdaptiveSelector({ windowSize: msg.adaptiveSelectorWindowSize });
  if (msg.adaptiveSnapshot.byteLength > 0) {
    adaptive.restore(msg.adaptiveSnapshot);
  }

  const rng = new Rng(msg.seed);

  const abortController = new AbortController();

  const compiler = new Compiler({
    command: msg.compiler.command,
    cwd: msg.compiler.cwd,
    functionName: msg.functionName,
    language: msg.language,
    signal: abortController.signal,
    sourcePrefix: msg.sourcePrefix,
  });

  const scorer = new Scorer(msg.scorer.targetObjectPath, msg.functionName, { ...msg.scorer.diffSettings });
  await scorer.init();

  const engine = new MutationEngine(registry, rng, {
    adaptiveSelector: adaptive,
    language: msg.language,
  });
  engine.setFocusConstraints([...msg.focusRegions], [...msg.avoidRegions]);

  state = {
    slotId: msg.slotId,
    engine,
    compiler,
    scorer,
    deduplicator: new Deduplicator(),
    functionName: msg.functionName,
    mutationDepth: msg.mutationDepth,
    registry,
    adaptive,
    abortController,
  };

  post({ kind: 'ready', slotId: msg.slotId, initMs: performance.now() - t0 });
}

async function handleJob(job: WorkerJob, s: WorkerState): Promise<void> {
  // Sample engine PROFILE_STATS deltas so the orchestrator can split mutate
  // into parse vs ruleApply. Both counters are updated only when
  // TRANSMUTER_PROFILE=1 is set; otherwise they remain 0 and report as 0 ms.
  const parseNs0 = PROFILE_STATS.parseNs;
  const ruleApplyNs0 = PROFILE_STATS.ruleApplyNs;

  const tMutate0 = performance.now();
  const mutation = s.engine.mutate(
    job.candidateSource,
    s.functionName,
    job.mutationTargetId,
    s.mutationDepth,
    job.breakdown,
  );
  const mutateMs = performance.now() - tMutate0;
  const parseMs = (PROFILE_STATS.parseNs - parseNs0) / 1e6;
  const ruleApplyMs = (PROFILE_STATS.ruleApplyNs - ruleApplyNs0) / 1e6;

  if (!mutation) {
    post({
      kind: 'no-mutation',
      jobId: job.jobId,
      timings: { mutate: mutateMs, parse: parseMs, ruleApply: ruleApplyMs },
    });
    return;
  }

  const tDedup0 = performance.now();
  const isDup = s.deduplicator.checkAndAdd(mutation.source);
  const dedupMs = performance.now() - tDedup0;

  if (isDup) {
    post({
      kind: 'dedup',
      jobId: job.jobId,
      timings: { mutate: mutateMs, parse: parseMs, ruleApply: ruleApplyMs, dedup: dedupMs },
    });
    return;
  }

  const ruleId = mutation.ruleIds[0] ?? 'unknown';

  const tCompile0 = performance.now();
  const compileResult = await s.compiler.compile(mutation.source);
  const compileMs = performance.now() - tCompile0;

  if (!compileResult.success) {
    const timings: PhaseTimings = {
      mutate: mutateMs,
      parse: parseMs,
      ruleApply: ruleApplyMs,
      dedup: dedupMs,
      compile: compileMs,
    };
    post({
      kind: 'compile-error',
      jobId: job.jobId,
      mutationTargetId: job.mutationTargetId,
      ruleId,
      error: compileResult.error,
      timings,
    });
    return;
  }

  const tScore0 = performance.now();
  let scored: Awaited<ReturnType<typeof s.scorer.scoreWithAssembly>>;
  let scoreMs: number;
  let scoreError: string | null = null;
  // try/finally guarantees Compiler.cleanup runs even if scoreWithAssembly
  // throws — without this, every scorer crash leaks the .o until the
  // worker shuts down and wipes the whole tmp dir.
  try {
    scored = await s.scorer.scoreWithAssembly(compileResult.objPath);
  } catch (err) {
    scored = null;
    scoreError = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    scoreMs = performance.now() - tScore0;
    await Compiler.cleanup(compileResult.objPath);
  }

  if (!scored) {
    // Compile actually succeeded; scoring either threw or couldn't find the
    // symbol (e.g. compiler optimised it away). Either way, report it as
    // 'scorer-failed' — the orchestrator must not blame the rule's
    // compile-error stats or call recordFailure on the target. Distinct
    // from 'compile-error'. Reporting here also ensures the attempt counts
    // toward `maxCompiles` instead of leaking through the catch-all error
    // path below as an uncounted worker error.
    post({
      kind: 'scorer-failed',
      jobId: job.jobId,
      mutationTargetId: job.mutationTargetId,
      ruleId,
      error: scoreError ?? 'scorer returned null (function symbol not found)',
      timings: {
        mutate: mutateMs,
        parse: parseMs,
        ruleApply: ruleApplyMs,
        dedup: dedupMs,
        compile: compileMs,
        score: scoreMs,
      },
    });
    return;
  }

  const result: WorkerResult = {
    kind: 'scored',
    jobId: job.jobId,
    mutationTargetId: job.mutationTargetId,
    mutatedSource: mutation.source,
    ruleId,
    location: mutation.location,
    score: scored.score,
    breakdown: scored.breakdown,
    assembly: scored.assembly,
    assemblyDiff: scored.assemblyDiff,
    timings: {
      mutate: mutateMs,
      parse: parseMs,
      ruleApply: ruleApplyMs,
      dedup: dedupMs,
      compile: compileMs,
      score: scoreMs,
    },
  };
  post(result);
}

function applyRules(
  registry: RuleRegistry,
  enabled: readonly string[],
  weights: Readonly<Record<string, number>>,
): void {
  const enabledSet = new Set(enabled);
  for (const rule of registry.all()) {
    if (enabledSet.has(rule.id)) {
      registry.enable(rule.id);
    } else {
      registry.disable(rule.id);
    }
  }
  registry.setWeights({ ...weights });
}

function post(msg: WorkerOutbound): void {
  // Bun's Web-Worker postMessage signature accepts a second transfer array; we
  // don't use transferables on the return path (all payloads are small strings).
  self.postMessage(msg);
}
