/**
 * `transmuter refine` command — improve code quality while preserving assembly match.
 */
import {
  Cleanup,
  type CleanupEvent,
  Compiler,
  type FocusConstraint,
  type Guideline,
  type RefinementResult,
  Refiner,
  type RefinerEvent,
  Scorer,
  type ViolationHypothesis,
  builtInGuidelines,
  detectLanguage,
  ensureLanguageRegistered,
} from '@transmuter/core';
import fs from 'fs/promises';
import { Box, Text, render, useApp } from 'ink';
import Spinner from 'ink-spinner';
import os from 'os';
import path from 'path';
import React, { useEffect, useRef, useState } from 'react';

import { type ControlServer, createControlServer, createRefineApp } from '../api/server.js';
import { loadDecompYaml } from '../config.js';

export interface RefineArgs {
  sourceFile: string;
  target?: string;
  function?: string;
  compiler?: string;
  cwd?: string;
  profile?: string;
  guideline?: string;
  concurrency?: number;
  maxCompiles?: number;
  timeout?: number;
  seed?: number;
  config?: string;
  skipMerge?: boolean;
  noCleanup?: boolean;
  sourcePrefix?: string;
  api?: boolean;
  apiPort?: number;
  focusConstraints?: FocusConstraint[];
  violationHypotheses?: ViolationHypothesis[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HypothesisScore {
  id: string;
  description: string;
  score: number;
}

interface ViolationState {
  id: string;
  description: string;
  status:
    | 'pending'
    | 'exploring'
    | 'trivially-fixed'
    | 'fixed'
    | 'removal-failed'
    | 'transmuter-exhausted'
    | 'resolved-by-prior';
  iteration: number;
  score: number;
  hypotheses: HypothesisScore[];
}

interface RefineState {
  phase: 'idle' | 'sanity-check' | 'detecting' | 'exploring' | 'merging' | 'done';
  violations: ViolationState[];
  mergeStep: number;
  mergeTotal: number;
  result: RefinementResult | null;
  error: string | null;
}

function reduceRefineEvent(state: RefineState, event: RefinerEvent): RefineState {
  switch (event.type) {
    case 'sanity-check-passed':
      return { ...state, phase: 'detecting' };

    case 'sanity-check-failed':
      return { ...state, error: event.error };

    case 'violations-detected':
      return {
        ...state,
        phase: 'exploring',
        violations: event.violations.map((v: { id: string; description: string }) => ({
          id: v.id,
          description: v.description,
          status: 'pending' as const,
          iteration: 0,
          score: -1,
          hypotheses: [],
        })),
      };

    case 'violation-fix-started':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId ? { ...v, status: 'exploring' as const } : v,
        ),
      };

    case 'violation-hypothesis-scored':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId
            ? {
                ...v,
                hypotheses: [
                  ...v.hypotheses,
                  { id: event.hypothesisId, description: event.description, score: event.score },
                ],
              }
            : v,
        ),
      };

    case 'violation-fix-progress':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId ? { ...v, iteration: event.iteration, score: event.score } : v,
        ),
      };

    case 'violation-trivially-fixed':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId ? { ...v, status: 'trivially-fixed' as const, score: 0 } : v,
        ),
      };

    case 'violation-fixed':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId ? { ...v, status: 'fixed' as const, score: 0, iteration: event.iterations } : v,
        ),
      };

    case 'violation-removal-failed':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId ? { ...v, status: 'removal-failed' as const } : v,
        ),
      };

    case 'violation-transmuter-exhausted':
      return {
        ...state,
        violations: state.violations.map((v) =>
          v.id === event.violationId
            ? { ...v, status: 'transmuter-exhausted' as const, score: event.bestScore, iteration: event.iterations }
            : v,
        ),
      };

    case 'merge-started':
      return { ...state, phase: 'merging', mergeStep: 0, mergeTotal: state.violations.length };

    case 'merge-step':
      return {
        ...state,
        mergeStep: event.step,
        violations: state.violations.map((v) => {
          if (v.id !== event.violationId) {
            return v;
          }
          if (event.action === 'skipped-already-resolved') {
            return { ...v, status: 'resolved-by-prior' as const };
          }
          if (event.action === 'applied-trivially') {
            return { ...v, status: 'trivially-fixed' as const };
          }
          if (event.action === 'permuted') {
            return { ...v, status: 'fixed' as const };
          }
          return { ...v, status: 'transmuter-exhausted' as const };
        }),
      };

    case 'completed':
      // Don't set phase to 'done' here — the run() function sets it after saving the report
      return { ...state, result: event.result };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// List mode — show available guidelines with violation counts
// ---------------------------------------------------------------------------

async function listGuidelines(args: RefineArgs): Promise<void> {
  const source = await fs.readFile(args.sourceFile, 'utf-8');
  const language = detectLanguage(args.sourceFile);
  ensureLanguageRegistered(language);
  const decompConfig = await loadDecompYaml(args.config, args.cwd);
  const transmuterConfig = decompConfig?.tools?.transmuter;

  const compilerCommand = args.compiler ?? transmuterConfig?.compiler;
  const fnName = args.function ?? '';
  const targetPath = args.target;

  // Verify the source matches (optional — just for the listing)
  let matchStatus = '';
  if (compilerCommand && fnName && targetPath) {
    try {
      const compiler = new Compiler({
        command: compilerCommand,
        cwd: args.cwd ?? process.cwd(),
        functionName: fnName,
        language,
      });
      const compileResult = await compiler.compile(source);
      if (compileResult.success) {
        const scorer = new Scorer(targetPath, fnName, transmuterConfig?.diffSettings);
        await scorer.init();
        const score = await scorer.score(compileResult.objPath);
        await Compiler.cleanup(compileResult.objPath);
        if (score === 0) {
          matchStatus = ' (source matches target)';
        } else if (score !== null) {
          matchStatus = ` (score: ${score} — not matching, refinement requires score 0)`;
        }
      }
      await compiler.destroy();
    } catch {
      // Ignore — listing still works without verification
    }
  }

  function ListApp(): React.ReactElement {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Available guidelines</Text>
          {fnName && <Text> for {fnName}</Text>}
          <Text dimColor>{matchStatus}</Text>
        </Box>

        {builtInGuidelines
          .filter((g: Guideline) => g.languages.includes(language))
          .map((g: Guideline) => {
            const violations = fnName ? g.detect(source, fnName) : [];
            return (
              <Box key={g.id}>
                <Text>
                  {'  '}
                  <Text bold>{g.id.padEnd(16)}</Text>
                  {'  '}
                  <Text>{g.description}</Text>
                  {fnName && violations.length > 0 && (
                    <Text color="yellow">
                      {' '}
                      ({violations.length} violation{violations.length === 1 ? '' : 's'})
                    </Text>
                  )}
                  {fnName && violations.length === 0 && <Text dimColor> (0 violations)</Text>}
                </Text>
              </Box>
            );
          })}

        <Box marginTop={1}>
          <Text dimColor>Use --guideline {'<id>'} to apply a specific guideline.</Text>
        </Box>
      </Box>
    );
  }

  const { waitUntilExit } = render(<ListApp />);
  await waitUntilExit();
}

// ---------------------------------------------------------------------------
// Refine dashboard
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}h ${m % 60}m ${s % 60}s`;
  }
  if (m > 0) {
    return `${m}m ${s % 60}s`;
  }
  return `${s}s`;
}

function ViolationLine({ v }: { v: ViolationState }): React.ReactElement {
  const isSuccess = v.status === 'trivially-fixed' || v.status === 'fixed' || v.status === 'resolved-by-prior';
  const isFailed = v.status === 'removal-failed' || v.status === 'transmuter-exhausted';
  const statusColor = isSuccess ? 'green' : isFailed ? 'red' : 'yellow';
  const statusIcon = isSuccess ? '\u2713' : isFailed ? '\u2717' : v.status === 'exploring' ? '' : '\u2022';

  return (
    <Box>
      <Text>
        {'  '}
        {v.status === 'exploring' ? <Spinner type="dots" /> : <Text color={statusColor}>{statusIcon}</Text>}{' '}
        <Text>{v.id.padEnd(20)}</Text>
        {v.status === 'exploring' && (
          <Text dimColor>
            score: {v.score >= 0 ? v.score : '?'} iter: {v.iteration.toLocaleString()}
          </Text>
        )}
        {v.status === 'trivially-fixed' && <Text color="green">trivially fixed</Text>}
        {v.status === 'fixed' && <Text color="green">fixed ({v.iteration.toLocaleString()} iterations)</Text>}
        {v.status === 'removal-failed' && <Text color="red">removal failed</Text>}
        {v.status === 'transmuter-exhausted' && (
          <Text color="red">
            exhausted (best: {v.score}, {v.iteration.toLocaleString()} iterations)
          </Text>
        )}
        {v.status === 'resolved-by-prior' && <Text color="green">resolved by prior fix</Text>}
        {v.status === 'pending' && <Text dimColor>pending</Text>}
      </Text>
      {v.hypotheses.length > 0 && (
        <Box flexDirection="column" marginLeft={4}>
          {v.hypotheses.map((h) => (
            <Text key={h.id} dimColor>
              {'  '}
              {h.description}: score {h.score >= 0 ? h.score : 'N/A'}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function Dashboard({
  state,
  functionName,
  guidelineId,
}: {
  state: RefineState;
  functionName: string;
  guidelineId: string;
}): React.ReactElement {
  if (state.phase === 'idle' || state.phase === 'sanity-check') {
    return (
      <Box>
        <Text>
          <Spinner type="dots" /> Verifying match...
        </Text>
      </Box>
    );
  }

  if (state.phase === 'detecting') {
    return (
      <Box>
        <Text>
          <Spinner type="dots" /> Detecting violations...
        </Text>
      </Box>
    );
  }

  const fixed = state.violations.filter(
    (v) => v.status === 'trivially-fixed' || v.status === 'fixed' || v.status === 'resolved-by-prior',
  ).length;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>transmuter refine</Text>
        <Text>
          {' \u2014 '}
          {functionName} \u2014 {guidelineId}
        </Text>
      </Box>

      <Box>
        <Text>
          Phase: <Text bold>{state.phase}</Text>
          {'  '}
          Violations:{' '}
          <Text bold>
            {fixed}/{state.violations.length}
          </Text>{' '}
          fixed
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {state.violations.map((v) => (
          <ViolationLine key={v.id} v={v} />
        ))}
      </Box>

      {state.phase === 'merging' && (
        <Box marginTop={1}>
          <Text>
            <Spinner type="dots" /> Merge step {state.mergeStep}/{state.mergeTotal}
          </Text>
        </Box>
      )}
    </Box>
  );
}

interface CleanupViewState {
  phase: 'idle' | 'phase1' | 'phase2' | 'done';
  phase1Pass: string;
  phase2Iteration: number;
  phase2BestSmell: number;
  smellBefore: number;
  smellAfter: number;
}

function CleanupIndicator({ cleanupState }: { cleanupState: CleanupViewState }): React.ReactElement {
  if (cleanupState.phase === 'phase1') {
    return (
      <Box marginTop={1}>
        <Text>
          <Spinner type="dots" /> Cleanup Phase 1: {cleanupState.phase1Pass || 'starting...'}
        </Text>
      </Box>
    );
  }
  if (cleanupState.phase === 'phase2') {
    return (
      <Box marginTop={1}>
        <Text>
          <Spinner type="dots" /> Cleanup Phase 2: smell {cleanupState.phase2BestSmell} iter{' '}
          {cleanupState.phase2Iteration.toLocaleString()}
        </Text>
      </Box>
    );
  }
  if (cleanupState.phase === 'done') {
    const improved = cleanupState.smellAfter < cleanupState.smellBefore;
    return (
      <Box marginTop={1}>
        <Text>
          {improved ? (
            <Text color="green">
              {'\u2713'} Cleanup: smell {cleanupState.smellBefore} {'\u2192'} {cleanupState.smellAfter}
            </Text>
          ) : (
            <Text dimColor>Cleanup: no improvement (smell {cleanupState.smellBefore})</Text>
          )}
        </Text>
      </Box>
    );
  }
  return <></>;
}

function CompletedView({
  state,
  reportPath,
  outputPath,
  cleanupState,
}: {
  state: RefineState;
  reportPath: string | null;
  outputPath: string | null;
  cleanupState: CleanupViewState | null;
}): React.ReactElement {
  const r = state.result;
  if (!r) {
    return (
      <Box>
        <Text color="red">Error: {state.error ?? 'Unknown error'}</Text>
      </Box>
    );
  }

  const allFixed = r.violationsFixed === r.violationsTotal;

  return (
    <Box flexDirection="column">
      <Box>
        {allFixed ? (
          <Text color="green" bold>
            {'\u2713'} All {r.violationsTotal} violations fixed!
          </Text>
        ) : r.violationsFixed > 0 ? (
          <Text color="yellow" bold>
            Partial: {r.violationsFixed}/{r.violationsTotal} violations fixed
          </Text>
        ) : (
          <Text color="red" bold>
            No violations could be fixed.
          </Text>
        )}
        <Text> Time: {formatDuration(r.elapsed)}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {state.violations.map((v) => (
          <ViolationLine key={v.id} v={v} />
        ))}
      </Box>

      {r.violationsFixed > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            Trivial: {r.trivialFixes} Permuted: {r.permutedFixes} Resolved by prior: {r.resolvedByPrior} Not fixable:{' '}
            {r.notFixable}
          </Text>
        </Box>
      )}

      {cleanupState && cleanupState.phase === 'done' && <CleanupIndicator cleanupState={cleanupState} />}

      {outputPath && (
        <Box>
          <Text dimColor>Output: {outputPath}</Text>
        </Box>
      )}
      {reportPath && (
        <Box>
          <Text dimColor>Report: {reportPath}</Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

function ApiIndicator({ port, discoveryPath }: { port: number; discoveryPath: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        API: http://127.0.0.1:{port} — {discoveryPath}
      </Text>
    </Box>
  );
}

function RefineApp({ args, onComplete }: { args: RefineArgs; onComplete: (code: number) => void }): React.ReactElement {
  const [state, setState] = useState<RefineState>({
    phase: 'idle',
    violations: [],
    mergeStep: 0,
    mergeTotal: 0,
    result: null,
    error: null,
  });
  const [reportPath, setReportPath] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [apiInfo, setApiInfo] = useState<{ port: number; discoveryPath: string } | null>(null);
  const [cleanupState, setCleanupState] = useState<CleanupViewState | null>(null);
  const controlServerRef = useRef<ControlServer | undefined>();
  const { exit } = useApp();

  useEffect(() => {
    if (state.phase === 'done' || state.error) {
      exit();
    }
  }, [state.phase, state.error]);

  useEffect(() => {
    const run = async () => {
      try {
        const source = await fs.readFile(args.sourceFile, 'utf-8');
        const language = detectLanguage(args.sourceFile);
        ensureLanguageRegistered(language);
        const decompConfig = await loadDecompYaml(args.config, args.cwd);
        const transmuterConfig = decompConfig?.tools?.transmuter;

        const compilerCommand = args.compiler ?? transmuterConfig?.compiler;
        if (!compilerCommand) {
          setState((s) => ({ ...s, error: 'No compiler command. Provide --compiler.' }));
          onComplete(3);
          return;
        }

        const fnName = args.function ?? '';
        if (!fnName) {
          setState((s) => ({ ...s, error: 'No function name. Provide --function.' }));
          onComplete(3);
          return;
        }

        const targetPath = args.target;
        if (!targetPath) {
          setState((s) => ({ ...s, error: 'No target object. Provide --target.' }));
          onComplete(3);
          return;
        }

        setState((s) => ({ ...s, phase: 'sanity-check' }));

        const seed = args.seed ?? Math.floor(Math.random() * 0xffffffff);

        const rawConcurrency = args.concurrency ?? transmuterConfig?.concurrency;
        if (rawConcurrency !== undefined && (!Number.isInteger(rawConcurrency) || rawConcurrency < 1)) {
          console.error(`Error: --concurrency must be a positive integer (got ${rawConcurrency}).`);
          process.exit(1);
        }
        const concurrency = rawConcurrency ?? Math.min(os.cpus().length, 4);

        const refiner = new Refiner({
          source,
          language,
          functionName: fnName,
          targetObjectPath: targetPath,
          compilerCommand,
          cwd: args.cwd ?? process.cwd(),
          sourcePrefix: args.sourcePrefix,
          profile: args.profile ?? transmuterConfig?.profile,
          guidelineId: args.guideline!,
          concurrency,
          maxCompilesPerViolation: args.maxCompiles ?? transmuterConfig?.maxCompiles,
          timeoutMsPerViolation: args.timeout ?? transmuterConfig?.timeoutMs,
          seed,
          diffSettings: transmuterConfig?.diffSettings,
          skipMerge: args.skipMerge,
          focusConstraints: args.focusConstraints,
          violationHypotheses: args.violationHypotheses,
          onEvent(event: RefinerEvent) {
            setState((s) => reduceRefineEvent(s, event));
          },
        });

        // Start control server if --api is set
        if (args.api) {
          const app = createRefineApp(refiner, refiner.getStore());
          const cs = await createControlServer({
            app,
            discoveryDir: path.dirname(path.resolve(args.sourceFile)),
            sessionId: refiner.getStore().toJSON().metadata.sessionId,
            port: args.apiPort,
          });
          controlServerRef.current = cs;
          setApiInfo({ port: cs.port, discoveryPath: cs.discoveryPath });
        }

        const result = await refiner.refine();
        const store = refiner.getStore();

        let finalSource = result.source;
        let cleanupReportData: import('@transmuter/core').CleanupReportData | undefined;

        // Run cleanup unless --no-cleanup, when at least one violation was fixed
        if (!args.noCleanup && result.violationsFixed > 0) {
          setCleanupState({
            phase: 'phase1',
            phase1Pass: '',
            phase2Iteration: 0,
            phase2BestSmell: 0,
            smellBefore: 0,
            smellAfter: 0,
          });

          const cleanup = new Cleanup({
            source: result.source,
            language,
            functionName: fnName,
            targetObjectPath: targetPath,
            compilerCommand,
            cwd: args.cwd ?? process.cwd(),
            sourcePrefix: args.sourcePrefix,
            profile: args.profile ?? transmuterConfig?.profile,
            seed: (args.seed ?? 42) + 1,
            diffSettings: transmuterConfig?.diffSettings,
            onEvent(event: CleanupEvent) {
              switch (event.type) {
                case 'phase1-started':
                  setCleanupState((s) => (s ? { ...s, phase: 'phase1' } : s));
                  break;
                case 'phase1-progress':
                  setCleanupState((s) => (s ? { ...s, phase1Pass: event.pass } : s));
                  break;
                case 'phase1-completed':
                  setCleanupState((s) => (s ? { ...s, smellBefore: event.smellBefore.total } : s));
                  break;
                case 'phase2-started':
                  setCleanupState((s) => (s ? { ...s, phase: 'phase2', phase2BestSmell: event.smellScore } : s));
                  break;
                case 'phase2-progress':
                  setCleanupState((s) =>
                    s ? { ...s, phase2Iteration: event.iteration, phase2BestSmell: event.bestSmell } : s,
                  );
                  break;
                case 'completed':
                  setCleanupState((s) =>
                    s
                      ? {
                          ...s,
                          phase: 'done',
                          smellBefore: event.result.smellBefore.total,
                          smellAfter: event.result.smellAfter.total,
                        }
                      : s,
                  );
                  break;
              }
            },
          });

          const cleanupResult = await cleanup.run();
          finalSource = cleanupResult.source;
          cleanupReportData = Cleanup.toReportData(result.source, cleanupResult);
        }

        // Write output if any violations were fixed
        if (result.violationsFixed > 0) {
          const sourceDir = path.dirname(path.resolve(args.sourceFile));
          const outPath = path.join(sourceDir, `${fnName}-refined.c`);
          await fs.writeFile(outPath, finalSource);
          setOutputPath(outPath);
        }

        // Save report (with cleanup data if available)
        const report = cleanupReportData ? { ...store.toJSON(), cleanup: cleanupReportData } : store.toJSON();
        const sourceDir = path.dirname(path.resolve(args.sourceFile));
        const reportFile = path.join(sourceDir, `refine-${Date.now()}.json`);
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
        setReportPath(reportFile);

        // Shut down control server
        await controlServerRef.current?.close();

        // Set phase to done AFTER report is saved (not from the event handler,
        // which fires before run() finishes saving)
        setState((s) => ({ ...s, phase: 'done' }));

        if (result.violationsFixed === result.violationsTotal) {
          onComplete(0);
        } else if (result.violationsFixed > 0) {
          onComplete(1);
        } else {
          onComplete(2);
        }
      } catch (err) {
        await controlServerRef.current?.close();
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
        onComplete(3);
      }
    };

    run();
  }, []);

  if (state.error) {
    return (
      <Box>
        <Text color="red">Error: {state.error}</Text>
      </Box>
    );
  }

  if (state.phase === 'done' && (!cleanupState || cleanupState.phase === 'done')) {
    return <CompletedView state={state} reportPath={reportPath} outputPath={outputPath} cleanupState={cleanupState} />;
  }

  return (
    <Box flexDirection="column">
      <Dashboard state={state} functionName={args.function ?? ''} guidelineId={args.guideline ?? ''} />
      {apiInfo && <ApiIndicator port={apiInfo.port} discoveryPath={apiInfo.discoveryPath} />}
      {cleanupState && cleanupState.phase !== 'done' && cleanupState.phase !== 'idle' && (
        <CleanupIndicator cleanupState={cleanupState} />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function refineCommand(args: RefineArgs): Promise<void> {
  // If no guideline specified, list available guidelines
  if (!args.guideline) {
    await listGuidelines(args);
    process.exit(0);
  }

  let exitCode = 0;
  const { waitUntilExit } = render(<RefineApp args={args} onComplete={(code) => (exitCode = code)} />, {
    exitOnCtrlC: false,
  });
  await waitUntilExit();
  process.exit(exitCode);
}
