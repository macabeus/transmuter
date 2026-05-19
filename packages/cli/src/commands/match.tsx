/**
 * `transmuter match` command — main permutation command with live dashboard.
 */
import {
  Cleanup,
  type CleanupEvent,
  type FocusConstraint,
  MutationSearch,
  type MutationSearchEvent,
  type MutationSearchOptions,
  type SessionConfig,
  SessionStore,
  defaultConcurrency,
  detectLanguage,
  ensureLanguageRegistered,
} from '@transmuter/core';
import fs from 'fs/promises';
import { Box, Text, render, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import path from 'path';
import React, { useEffect, useRef, useState } from 'react';

import { type ControlServer, createControlServer, createMatchApp } from '../api/server.js';
import { type CliState, initialState, reduceEvent } from '../bridge.js';
import { loadDecompYaml } from '../config.js';

export interface MatchArgs {
  sourceFile: string;
  target?: string;
  function?: string;
  compiler?: string;
  cwd?: string;
  profile?: string;
  concurrency?: number;
  maxCompiles?: number;
  timeout?: number;
  seed?: number;
  noReduce?: boolean;
  isolate?: boolean;
  depth?: number;
  noCleanup?: boolean;
  config?: string;
  version?: string;
  sourcePrefix?: string;
  api?: boolean;
  apiPort?: number;
  focusConstraints?: FocusConstraint[];
}

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

function sparkline(values: number[]): string {
  if (values.length === 0) {
    return '';
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const chars = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (chars.length - 1));
      return chars[idx];
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({
  state,
  functionName,
  profileId,
}: {
  state: CliState;
  functionName: string;
  profileId: string;
}): React.ReactElement {
  if (state.phase === 'idle') {
    return (
      <Box>
        <Text>
          <Spinner type="dots" /> Initializing...
        </Text>
      </Box>
    );
  }

  const improvement = state.baseScore > 0 ? state.baseScore - state.bestScore : 0;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>transmuter</Text>
        <Text>
          {' '}
          — {functionName} — {profileId}
        </Text>
      </Box>

      <Box>
        <Text>
          {'Score   '}
          <Text color="yellow">{state.baseScore}</Text>
          {' \u2192 '}
          <Text color="green" bold>
            {state.bestScore}
          </Text>
          {improvement > 0 && <Text color="green"> \u2193{improvement}</Text>}
          {'  '}
          <Spinner type="dots" />
          {'  Iteration: '}
          <Text bold>{state.iteration.toLocaleString()}</Text>
        </Text>
      </Box>

      {state.scoreHistory.length > 1 && (
        <Box marginTop={1}>
          <Text dimColor>
            {state.baseScore} {sparkline(state.scoreHistory)} {state.bestScore}
          </Text>
        </Box>
      )}

      {state.targets.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Targets ({state.targets.length})</Text>
          {state.targets.slice(0, 10).map((t) => (
            <Box key={t.id}>
              <Text>
                {'  '}
                {t.id.padEnd(14)} score={String(t.score).padEnd(6)} {!t.enabled && <Text color="red">(disabled)</Text>}
              </Text>
            </Box>
          ))}
          {state.targets.length > 10 && (
            <Box>
              <Text dimColor> ... and {state.targets.length - 10} more</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {state.compiled} compiled {'\u00b7'} {state.forkCount} forks {'\u00b7'} {state.errors} errors {'\u00b7'}{' '}
          {formatDuration(state.elapsed)}
        </Text>
      </Box>

      {state.lastFork && (
        <Box>
          <Text dimColor>
            Last fork: {state.lastFork.oldScore} {'\u2192'} {state.lastFork.newScore} via {state.lastFork.ruleId}
          </Text>
        </Box>
      )}

      {state.errorMessage && (
        <Box marginTop={1}>
          <Text color="red">Error: {state.errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
}

function ApiIndicator({ port, discoveryPath }: { port: number; discoveryPath: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        API: http://127.0.0.1:{port} — {discoveryPath}
      </Text>
    </Box>
  );
}

interface CleanupState {
  phase: 'idle' | 'phase1' | 'phase2' | 'done';
  phase1Pass: string;
  phase2Iteration: number;
  phase2BestSmell: number;
  smellBefore: number;
  smellAfter: number;
}

function CleanupView({ cleanupState }: { cleanupState: CleanupState }): React.ReactElement {
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
  cleanupState,
}: {
  state: CliState;
  reportPath: string | null;
  cleanupState: CleanupState | null;
}): React.ReactElement {
  const isPerfect = state.bestScore === 0;
  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {isPerfect ? (
            <Text color="green" bold>
              {'\u2713'} Perfect match!
            </Text>
          ) : (
            <Text color="yellow" bold>
              Done.
            </Text>
          )}
          {'  Score: '}
          <Text bold>{state.bestScore}</Text>
          {'  Iterations: '}
          {state.iteration.toLocaleString()}
          {'  Time: '}
          {formatDuration(state.elapsed)}
        </Text>
      </Box>
      {state.completionReason && state.completionReason !== 'perfect-match' && (
        <Box>
          <Text dimColor>Stopped: {state.completionReason}</Text>
        </Box>
      )}
      {state.errorMessage && (
        <Box>
          <Text color="red">Error: {state.errorMessage}</Text>
        </Box>
      )}
      {cleanupState && cleanupState.phase === 'done' && <CleanupView cleanupState={cleanupState} />}
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

type AppPhase = 'running' | 'stopping' | 'done';

function MatchApp({ args, onComplete }: { args: MatchArgs; onComplete: (code: number) => void }): React.ReactElement {
  const [state, setState] = useState<CliState>(initialState());
  const [phase, setPhase] = useState<AppPhase>('running');
  const [functionName, setFunctionName] = useState(args.function ?? '');
  const [profileId, setProfileId] = useState(args.profile ?? 'auto');
  const [reportPath, setReportPath] = useState<string | null>(null);
  const [apiInfo, setApiInfo] = useState<{ port: number; discoveryPath: string } | null>(null);
  const [cleanupState, setCleanupState] = useState<CleanupState | null>(null);
  const searchRef = useRef<MutationSearch | undefined>();
  const storeRef = useRef<SessionStore | undefined>();
  const controlServerRef = useRef<ControlServer | undefined>();
  const { exit } = useApp();

  // Ctrl+C: stop search gracefully
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c' && phase === 'running') {
        setPhase('stopping');
        searchRef.current?.stop();
      }
    },
    { isActive: process.stdin.isTTY === true },
  );

  // Exit when done
  useEffect(() => {
    if (phase === 'done') {
      exit();
    }
  }, [phase]);

  // Main logic
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
          setState((s) => ({
            ...s,
            phase: 'completed',
            errorMessage:
              'No compiler command specified.\nProvide --compiler or add tools.transmuter.compiler to decomp.yaml.',
          }));
          onComplete(1);
          setPhase('done');
          return;
        }

        const fnName = args.function ?? '';
        if (!fnName) {
          setState((s) => ({
            ...s,
            phase: 'completed',
            errorMessage: 'No function name specified. Provide --function.',
          }));
          onComplete(1);
          setPhase('done');
          return;
        }
        setFunctionName(fnName);

        const resolvedProfile = args.profile ?? transmuterConfig?.profile;
        if (resolvedProfile) {
          setProfileId(resolvedProfile);
        }

        const targetPath = args.target;
        if (!targetPath) {
          setState((s) => ({
            ...s,
            phase: 'completed',
            errorMessage: 'No target object specified. Provide --target.',
          }));
          onComplete(1);
          setPhase('done');
          return;
        }

        let workingSource = source;
        let contextSource: string | undefined;
        if (args.isolate ?? transmuterConfig?.isolate) {
          if (language !== 'c') {
            console.error(`Error: --isolate is only supported for C sources (got '${language}').`);
            process.exit(1);
          }
          const { isolateFunction } = await import('@transmuter/core');
          const result = isolateFunction(workingSource, fnName);
          contextSource = workingSource;
          workingSource = result.source;
        }

        let finalSource = workingSource;
        if (!(args.noReduce ?? transmuterConfig?.noReduce)) {
          const { Reducer } = await import('@transmuter/core');
          const reducer = new Reducer({
            source: workingSource,
            functionName: fnName,
            targetObjectPath: targetPath,
            compilerCommand,
            cwd: args.cwd ?? process.cwd(),
            sourcePrefix: args.sourcePrefix,
          });
          const result = await reducer.reduce();
          finalSource = result.source;
        }

        const seed = args.seed ?? Math.floor(Math.random() * 0xffffffff);
        const rawConcurrency = args.concurrency ?? transmuterConfig?.concurrency;
        if (rawConcurrency !== undefined && (!Number.isInteger(rawConcurrency) || rawConcurrency < 1)) {
          console.error(`Error: --concurrency must be a positive integer (got ${rawConcurrency}).`);
          process.exit(1);
        }
        const concurrency = rawConcurrency ?? defaultConcurrency();
        const maxCompiles = args.maxCompiles ?? transmuterConfig?.maxCompiles;
        const timeoutMs = args.timeout ?? transmuterConfig?.timeoutMs;
        const mutationDepth = args.depth ?? transmuterConfig?.mutationDepth;

        // Create session store
        const store = new SessionStore({
          metadata: { label: `${fnName} — CLI match` },
          focusConstraints: args.focusConstraints,
        });
        storeRef.current = store;
        store.setOriginalSource(finalSource);
        if (contextSource !== undefined) {
          store.setContextSource(contextSource);
        }
        store.setConfig({
          functionName: fnName,
          targetObjectPath: targetPath,
          compilerCommand,
          language,
          profile: resolvedProfile,
          concurrency,
          maxCompiles: maxCompiles ?? Infinity,
          timeoutMs: timeoutMs ?? Infinity,
          seed,
          mutationDepth: mutationDepth ?? 1,
          lateralForkBudget: 0,
          ruleWeights: transmuterConfig?.ruleWeights ?? {},
          disabledRules: transmuterConfig?.disabledRules ?? [],
          focusConstraints: args.focusConstraints ?? [],
        } satisfies SessionConfig);

        const opts: MutationSearchOptions = {
          source: finalSource,
          language,
          functionName: fnName,
          targetObjectPath: targetPath,
          compilerCommand,
          cwd: args.cwd ?? process.cwd(),
          profile: resolvedProfile,
          concurrency,
          maxCompiles,
          timeoutMs,
          seed,
          mutationDepth,
          ruleWeights: transmuterConfig?.ruleWeights,
          disabledRules: transmuterConfig?.disabledRules,
          diffSettings: transmuterConfig?.diffSettings,
          sourcePrefix: args.sourcePrefix,
          focusConstraints: args.focusConstraints,
          onEvent(event: MutationSearchEvent) {
            setState((s) => reduceEvent(s, event));
            store.push(event);
          },
        };

        const search = new MutationSearch(opts);
        searchRef.current = search;

        // Start control server if --api is set
        if (args.api) {
          const app = createMatchApp(search, store);
          const cs = await createControlServer({
            app,
            discoveryDir: path.dirname(path.resolve(args.sourceFile)),
            sessionId: store.toJSON().metadata.sessionId,
            port: args.apiPort,
          });
          controlServerRef.current = cs;
          setApiInfo({ port: cs.port, discoveryPath: cs.discoveryPath });
        }

        const result = await search.start();

        let cleanedSource = result.bestSource;
        let cleanupReportData: import('@transmuter/core').CleanupReportData | undefined;

        // Run cleanup unless --no-cleanup, when we got a perfect match
        if (!args.noCleanup && result.perfectMatch) {
          setCleanupState({
            phase: 'phase1',
            phase1Pass: '',
            phase2Iteration: 0,
            phase2BestSmell: 0,
            smellBefore: 0,
            smellAfter: 0,
          });

          const cleanup = new Cleanup({
            source: result.bestSource,
            language,
            functionName: fnName,
            targetObjectPath: targetPath,
            compilerCommand,
            cwd: args.cwd ?? process.cwd(),
            sourcePrefix: args.sourcePrefix,
            profile: resolvedProfile,
            seed: seed + 1,
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
          cleanedSource = cleanupResult.source;
          cleanupReportData = Cleanup.toReportData(result.bestSource, cleanupResult);
        }

        if (result.bestScore < result.baseScore || result.perfectMatch) {
          const sourceDir = path.dirname(path.resolve(args.sourceFile));
          const outPath = path.join(sourceDir, `${fnName}-${result.bestScore}.c`);
          await fs.writeFile(outPath, cleanedSource);
        }

        // Save session report (with cleanup data if available)
        const report = cleanupReportData ? { ...store.toJSON(), cleanup: cleanupReportData } : store.toJSON();
        const sourceDir = path.dirname(path.resolve(args.sourceFile));
        const reportFile = path.join(sourceDir, `session-${Date.now()}.json`);
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
        setReportPath(reportFile);

        onComplete(result.perfectMatch ? 0 : 1);
      } catch (err) {
        setState((s) => ({ ...s, phase: 'completed', errorMessage: err instanceof Error ? err.message : String(err) }));
        onComplete(1);
      }

      // Shut down control server
      await controlServerRef.current?.close();

      setPhase('done');
    };

    run();

    return () => {
      searchRef.current?.stop();
      controlServerRef.current?.close();
    };
  }, []);

  if (phase === 'done' || (state.phase === 'completed' && (!cleanupState || cleanupState.phase === 'done'))) {
    return <CompletedView state={state} reportPath={reportPath} cleanupState={cleanupState} />;
  }

  if (phase === 'stopping') {
    return (
      <Box flexDirection="column">
        <Dashboard state={state} functionName={functionName} profileId={profileId} />
        {apiInfo && <ApiIndicator port={apiInfo.port} discoveryPath={apiInfo.discoveryPath} />}
        <Box marginTop={1}>
          <Text>
            <Spinner type="dots" /> Stopping...
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Dashboard state={state} functionName={functionName} profileId={profileId} />
      {apiInfo && <ApiIndicator port={apiInfo.port} discoveryPath={apiInfo.discoveryPath} />}
      {cleanupState && cleanupState.phase !== 'done' && cleanupState.phase !== 'idle' && (
        <CleanupView cleanupState={cleanupState} />
      )}
    </Box>
  );
}

export async function matchCommand(args: MatchArgs): Promise<void> {
  let exitCode = 0;

  const { waitUntilExit } = render(<MatchApp args={args} onComplete={(code) => (exitCode = code)} />, {
    exitOnCtrlC: false,
  });

  await waitUntilExit();
  process.exit(exitCode);
}
