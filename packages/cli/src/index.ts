#!/usr/bin/env bun
/**
 * @transmuter/cli — entry point
 *
 * Commands:
 *   transmuter match <source>           Match permutation job
 *   transmuter refine <source>          Improve code quality while preserving assembly match
 *   transmuter profile-detect           Detect compiler profile and show rule weights
 *   transmuter ctl <action>             Control a running session (requires --api)
 */
import { parseArgs } from 'util';

import { type CtlArgs, ctlCommand } from './commands/ctl.js';
import { type MatchArgs, matchCommand } from './commands/match.js';
import { type ProfileDetectArgs, profileDetectCommand } from './commands/profile-detect.js';
import { type RefineArgs, refineCommand } from './commands/refine.js';
import { loadConstraints } from './load-constraints.js';

const USAGE = `
Usage: transmuter <command> [options]

Commands:
  match <source.c>     Match permutation job with live dashboard
  refine <source.c>    Improve code quality while preserving assembly match
  profile-detect       Detect compiler profile and show rule weights
  ctl <action>         Control a running session (requires --api on match)

Match Options:
  --target <path>      Path to target object file (.o)
  --function <name>    Target function name
  --compiler <cmd>     Compiler command template
  --cwd <path>         Working directory for compiler
  --profile <id>       Compiler profile (agbcc, old-agbcc, ido, mips-gcc-272)
  --concurrency <n>    Number of concurrent slots (default: min(cpus, 4))
                       Each slot runs in its own Bun Worker thread
  --max-compiles <n>   Maximum compile attempts before stopping. Counts only
                       mutations that survive dedup and reach the compiler;
                       no-mutation/dedup early-exits don't count.
  --timeout <ms>       Maximum time in milliseconds
  --seed <n>           RNG seed for reproducibility (use with --concurrency 1
                       and --max-compiles for bit-identical runs)
  --no-reduce          Skip source reduction before permuting
  --isolate            Replace non-target, non-inline function bodies with
                       forward declarations before reduce/match — useful on
                       preprocessed .ctx files. C only; macros are preserved.
  --depth <n>          Mutations per iteration (default: 1)
  --no-cleanup         Skip cleanup after finding a match
  --config <path>      Path to decomp.yaml
  --version <name>     Version name for multi-version projects
  --api                Start HTTP control server for external access
  --api-port <n>       Fixed port for the API server (default: random)
  --constraints <path> JSON file with focusConstraints (focus-region,
                       avoid-region, hypothesis) to bias mutation
                       selection. See .claude/docs/refine-mode.md for
                       the schema (violationHypotheses is refine-only).

Refine Options:
  --target <path>      Path to target object file (.o)
  --function <name>    Target function name
  --compiler <cmd>     Compiler command template
  --guideline <id>     Guideline to apply (omit to list available)
  --cwd <path>         Working directory for compiler
  --profile <id>       Compiler profile
  --concurrency <n>    Total concurrent slots (default: min(cpus, 4))
  --max-compiles <n>   Max compile attempts per violation (default: unlimited)
                       Counts only mutations that reach the compiler.
  --timeout <ms>       Max time per violation in ms (default: unlimited)
  --seed <n>           RNG seed for reproducibility
  --skip-merge         Only run Phase 1 exploration, skip merge
  --no-cleanup         Skip cleanup after refinement
  --config <path>      Path to decomp.yaml
  --constraints <path> JSON file with focusConstraints and/or
                       violationHypotheses to guide each violation's
                       sub-search. See .claude/docs/refine-mode.md.

Profile-detect Options:
  --profile <id>       Force a specific profile instead of auto-detecting
  --compiler <cmd>     Compiler command for detection (overrides decomp.yaml)
  --cwd <path>         Working directory (for finding decomp.yaml)
  --config <path>      Explicit path to decomp.yaml
  --language <lang>    Filter rules by language (c, cpp, pascal)
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  switch (command) {
    case 'match': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          target: { type: 'string' },
          function: { type: 'string' },
          compiler: { type: 'string' },
          cwd: { type: 'string' },
          profile: { type: 'string' },
          concurrency: { type: 'string' },
          'max-compiles': { type: 'string' },
          timeout: { type: 'string' },
          seed: { type: 'string' },
          'no-reduce': { type: 'boolean' },
          isolate: { type: 'boolean' },
          depth: { type: 'string' },
          'no-cleanup': { type: 'boolean' },
          config: { type: 'string' },
          version: { type: 'string' },
          'source-prefix': { type: 'string' },
          api: { type: 'boolean' },
          'api-port': { type: 'string' },
          constraints: { type: 'string' },
        },
      });

      if (!positionals[0]) {
        console.error('Error: source file is required.\nUsage: transmuter match <source.c> [options]');
        process.exit(1);
      }

      const matchConstraints = values.constraints ? await loadConstraints(values.constraints) : undefined;
      if (matchConstraints?.violationHypotheses?.length) {
        console.error(
          'Warning: violationHypotheses in constraints file are ignored by `match` ' +
            '(they are refine-only). Pass `hypothesis` constraints inside focusConstraints instead.',
        );
      }

      const matchArgs: MatchArgs = {
        sourceFile: positionals[0],
        target: values.target,
        function: values.function,
        compiler: values.compiler,
        cwd: values.cwd,
        profile: values.profile,
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        maxCompiles: values['max-compiles'] ? Number(values['max-compiles']) : undefined,
        timeout: values.timeout ? Number(values.timeout) : undefined,
        seed: values.seed ? Number(values.seed) : undefined,
        noReduce: values['no-reduce'],
        isolate: values.isolate,
        depth: values.depth ? Number(values.depth) : undefined,
        noCleanup: values['no-cleanup'],
        config: values.config,
        version: values.version,
        sourcePrefix: values['source-prefix']
          ? await import('fs/promises').then((fs) => fs.readFile(values['source-prefix']!, 'utf-8'))
          : undefined,
        api: values.api,
        apiPort: values['api-port'] ? Number(values['api-port']) : undefined,
        focusConstraints: matchConstraints?.focusConstraints,
      };

      await matchCommand(matchArgs);
      break;
    }

    case 'refine': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          target: { type: 'string' },
          function: { type: 'string' },
          compiler: { type: 'string' },
          guideline: { type: 'string' },
          cwd: { type: 'string' },
          profile: { type: 'string' },
          concurrency: { type: 'string' },
          'max-compiles': { type: 'string' },
          timeout: { type: 'string' },
          seed: { type: 'string' },
          'skip-merge': { type: 'boolean' },
          'no-cleanup': { type: 'boolean' },
          config: { type: 'string' },
          constraints: { type: 'string' },
          'source-prefix': { type: 'string' },
          api: { type: 'boolean' },
          'api-port': { type: 'string' },
        },
      });

      if (!positionals[0]) {
        console.error('Error: source file is required.\nUsage: transmuter refine <source.c> [options]');
        process.exit(1);
      }

      const refineConstraints = values.constraints ? await loadConstraints(values.constraints) : undefined;
      const focusConstraints = refineConstraints?.focusConstraints;
      const violationHypotheses = refineConstraints?.violationHypotheses;

      const refineArgs: RefineArgs = {
        sourceFile: positionals[0],
        target: values.target,
        function: values.function,
        compiler: values.compiler,
        guideline: values.guideline,
        cwd: values.cwd,
        profile: values.profile,
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        maxCompiles: values['max-compiles'] ? Number(values['max-compiles']) : undefined,
        timeout: values.timeout ? Number(values.timeout) : undefined,
        seed: values.seed ? Number(values.seed) : undefined,
        skipMerge: values['skip-merge'],
        noCleanup: values['no-cleanup'],
        config: values.config,
        focusConstraints,
        violationHypotheses,
        sourcePrefix: values['source-prefix']
          ? await import('fs/promises').then((fs) => fs.readFile(values['source-prefix']!, 'utf-8'))
          : undefined,
        api: values.api,
        apiPort: values['api-port'] ? Number(values['api-port']) : undefined,
      };

      await refineCommand(refineArgs);
      break;
    }

    case 'profile-detect': {
      const { values } = parseArgs({
        args: rest,
        options: {
          profile: { type: 'string' },
          compiler: { type: 'string' },
          cwd: { type: 'string' },
          config: { type: 'string' },
          language: { type: 'string' },
        },
      });

      const profileDetectArgs: ProfileDetectArgs = {
        profile: values.profile,
        compiler: values.compiler,
        cwd: values.cwd,
        config: values.config,
        language: values.language,
      };

      await profileDetectCommand(profileDetectArgs);
      break;
    }

    case 'ctl': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          'control-file': { type: 'string' },
        },
      });

      const ctlArgs: CtlArgs = {
        action: positionals[0] ?? '',
        params: positionals.slice(1),
        controlFile: values['control-file'],
      };

      await ctlCommand(ctlArgs);
      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
