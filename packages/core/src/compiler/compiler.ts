/**
 * Wraps a shell-based compiler command for use in the mutation pipeline.
 */
import { type Outcome, type Runner, type Scratch, createRunner } from '@match-kit/compiler';
import fs from 'fs/promises';
import type { Language } from '~/language.js';
import type { CompileResult } from '~/types.js';

/** Map Language to file extension used for temp source files. */
const LANG_EXT: Record<Language, string> = {
  c: 'c',
  cpp: 'cpp',
  pascal: 'pas',
};

/** Compiler output kept in an error, per stream. */
const MAX_OUTPUT_BYTES = 50_000;

/** Returns each object a caller still holds to its compiler's free scratches. */
const releases = new Map<string, () => void>();

/** The error text for a failed compile. */
function describe(outcome: Exclude<Outcome, { kind: 'ok' }>): string {
  switch (outcome.kind) {
    case 'rejected':
      return outcome.output || `Compiler exited with code ${outcome.exitCode}`;
    case 'no-object':
      return 'Compiler produced no output file';
    case 'killed':
      return (
        outcome.output ||
        `Compiler was killed (${outcome.exitCode === null ? 'by a signal' : `exit ${outcome.exitCode}`})`
      );
    case 'aborted':
      return 'Aborted';
    case 'spawn-failed':
      return outcome.message;
  }
}

export class Compiler {
  #runner: Runner;
  #functionName: string;
  #sourcePrefix: string;
  #ext: string;
  /** Scratches whose last object was cleaned up, ready for the next compile. */
  #free: Scratch[] = [];
  /** Objects this compiler made that a caller still holds. */
  #held = new Set<string>();

  /** Throws a `TemplateError` when `command` lacks `{{inputPath}}` or `{{outputPath}}`, or has an unknown placeholder. */
  constructor(opts: {
    command: string;
    cwd: string;
    functionName: string;
    language?: Language;
    signal?: AbortSignal;
    sourcePrefix?: string;
  }) {
    this.#runner = createRunner(opts.command, { cwd: opts.cwd, signal: opts.signal, maxOutputBytes: MAX_OUTPUT_BYTES });
    this.#functionName = opts.functionName;
    this.#sourcePrefix = opts.sourcePrefix ?? '';
    this.#ext = LANG_EXT[opts.language ?? 'c'];
  }

  /**
   * Compile a source code to an object file. The object lives until `Compiler.cleanup` or
   * `Compiler.objectFile` releases it, or until `destroy()`.
   */
  async compile(source: string): Promise<CompileResult> {
    const scratch = this.#free.pop() ?? this.#runner.scratch();
    let outcome: Outcome;
    try {
      outcome = await scratch.compile(this.#sourcePrefix + source, { ext: this.#ext, symbol: this.#functionName });
    } catch (err) {
      this.#free.push(scratch);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.kind !== 'ok') {
      this.#free.push(scratch);
      return { success: false, error: describe(outcome) };
    }
    const objPath = outcome.object;
    this.#held.add(objPath);
    releases.set(objPath, () => {
      this.#held.delete(objPath);
      this.#free.push(scratch);
    });
    return { success: true, objPath };
  }

  /** Clean up a compiled object file. */
  static async cleanup(objPath: string): Promise<void> {
    await fs.unlink(objPath).catch(() => {});
    releases.get(objPath)?.();
    releases.delete(objPath);
  }

  /** A compiled object file, removed when the `await using` that holds it ends. */
  static objectFile(objPath: string): AsyncDisposable & { readonly path: string } {
    return { path: objPath, [Symbol.asyncDispose]: () => Compiler.cleanup(objPath) };
  }

  /** Wait for the compiles in flight, then remove every scratch directory. Called on shutdown. */
  async destroy(): Promise<void> {
    await this.#runner.dispose();
    for (const objPath of this.#held) {
      releases.delete(objPath);
    }
    this.#held.clear();
    this.#free = [];
  }
}
