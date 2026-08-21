/**
 * Wraps a shell-based compiler command for use in the mutation pipeline.
 */
import { closeSync, existsSync, openSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Language } from '~/language.js';
import type { CompileResult } from '~/types.js';

/** Map Language to file extension used for temp source files. */
const LANG_EXT: Record<Language, string> = {
  c: '.c',
  cpp: '.cpp',
  pascal: '.pas',
};

/**
 * Locate a POSIX shell to run compiler commands through.
 *
 * The command templates are written in `sh` syntax, so on Windows we look for
 * a real `sh.exe` (Git for Windows / MSYS2) rather than falling back to cmd.
 * Override with $TRANSMUTER_SHELL if it lives somewhere unusual.
 */
let cachedShell: string | undefined;
function resolveShell(): string {
  if (cachedShell !== undefined) {
    return cachedShell;
  }

  const override = process.env.TRANSMUTER_SHELL;
  if (override !== undefined && override !== '') {
    cachedShell = override;
    return cachedShell;
  }

  if (os.platform() === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
      'C:\\Program Files\\Git\\bin\\sh.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe',
      'C:\\msys64\\usr\\bin\\sh.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        cachedShell = candidate;
        return cachedShell;
      }
    }
    throw new Error(
      'No POSIX shell found. Install Git for Windows or set $TRANSMUTER_SHELL ' +
        'to the absolute path of sh.exe.',
    );
  }

  cachedShell = '/bin/sh';
  return cachedShell;
}

export class Compiler {
  #command: string;
  #cwd: string;
  #functionName: string;
  #signal?: AbortSignal;
  #sourcePrefix: string;
  #ext: string;
  #tmpDirPromise: Promise<string> | null = null;
  #compileCounter = 0;
  #inFlight = new Set<Promise<CompileResult>>();

  constructor(opts: {
    command: string;
    cwd: string;
    functionName: string;
    language?: Language;
    signal?: AbortSignal;
    sourcePrefix?: string;
  }) {
    this.#command = opts.command;
    this.#cwd = opts.cwd;
    this.#functionName = opts.functionName;
    this.#signal = opts.signal;
    this.#sourcePrefix = opts.sourcePrefix ?? '';
    this.#ext = LANG_EXT[opts.language ?? 'c'];
  }

  /**
   * Ensure the shared temp directory exists.
   */
  #ensureTmpDir(): Promise<string> {
    if (!this.#tmpDirPromise) {
      this.#tmpDirPromise = fs.mkdtemp(path.join(os.tmpdir(), 'transmuter-'));
    }
    return this.#tmpDirPromise;
  }

  /**
   * Compile a source code to an object file.
   */
  compile(source: string): Promise<CompileResult> {
    const promise = this.#compileInner(source);
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise));
    return promise;
  }

  async #compileInner(source: string): Promise<CompileResult> {
    if (this.#signal?.aborted) {
      return { success: false, error: 'Aborted' };
    }

    let inputPath = '';
    let outputPath = '';
    try {
      const tmpDir = await this.#ensureTmpDir();
      const id = this.#compileCounter++;
      inputPath = path.join(tmpDir, `input-${id}${this.#ext}`);
      outputPath = path.join(tmpDir, `output-${id}.o`);

      await Bun.write(inputPath, this.#sourcePrefix + source);

      const rendered = this.#command
        .replaceAll('{{inputPath}}', inputPath)
        .replaceAll('{{outputPath}}', outputPath)
        .replaceAll('{{functionName}}', this.#functionName);

      const stdoutPath = path.join(tmpDir, `output-${id}.stdout`);
      const stderrPath = path.join(tmpDir, `output-${id}.stderr`);
      const result = await this.#exec(rendered, stdoutPath, stderrPath);

      const cleanupAux = (): Promise<unknown> =>
        Promise.all([
          fs.unlink(stdoutPath).catch(() => {}),
          fs.unlink(stderrPath).catch(() => {}),
          fs.unlink(inputPath).catch(() => {}),
        ]);

      if (result.exitCode !== 0) {
        await Promise.all([cleanupAux(), fs.unlink(outputPath).catch(() => {})]);
        return {
          success: false,
          error: result.stderr.trim() || result.stdout.trim() || `Compiler exited with code ${result.exitCode}`,
        };
      }

      // exitCode 0 but no output file = misconfigured compilerCommand (e.g.
      // missing `-o`). Surface that here rather than letting Scorer fail with
      // a more cryptic message downstream.
      try {
        await fs.access(outputPath);
      } catch {
        await cleanupAux();
        return { success: false, error: 'Compiler produced no output file' };
      }

      await cleanupAux();
      return { success: true, objPath: outputPath };
    } catch (err) {
      await Promise.all([fs.unlink(inputPath).catch(() => {}), fs.unlink(outputPath).catch(() => {})]);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Clean up a compiled object file. */
  static async cleanup(objPath: string): Promise<void> {
    await fs.unlink(objPath).catch(() => {});
  }

  /** Remove the shared temp directory. Called on shutdown. */
  async destroy(): Promise<void> {
    // Wait for any in-flight compiles before wiping the tmp dir from under them.
    if (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }

    if (this.#tmpDirPromise) {
      const dir = await this.#tmpDirPromise.catch(() => null);
      this.#tmpDirPromise = null;
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async #exec(
    command: string,
    stdoutPath: string,
    stderrPath: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Route child stdout/stderr to regular files (fd stdio) rather than
    // IPC pipes. Writing Wine-backed subprocess stderr through a Bun pipe
    // adds ~5 s of wall per compile on macOS (Wine Crossover + mwcceppc); fd
    // stdio has no such penalty. We read the files after the child exits.
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    try {
      stdoutFd = openSync(stdoutPath, 'w');
      stderrFd = openSync(stderrPath, 'w');
    } catch (err) {
      if (stdoutFd !== undefined) {
        closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        closeSync(stderrFd);
      }
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }

    // `detached: true` puts the child in its own process group so we can
    // `kill(-pgid)` grandchildren on abort. Without it, aborting a command
    // like `gcc … && as …` would kill the shell but leave the compiler
    // running.
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([resolveShell(), '-c', command], {
        cwd: this.#cwd,
        stdio: ['ignore', stdoutFd, stderrFd],
        detached: true,
      });
    } catch (err) {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }

    const onAbort = () => {
      try {
        if (proc.pid !== undefined) {
          // Negative pid → signal the whole process group.
          process.kill(-proc.pid, 'SIGTERM');
        }
      } catch {
        /* already dead */
      }
    };
    this.#signal?.addEventListener('abort', onAbort, { once: true });

    let exitCode: number;
    let fallbackErr: string | undefined;
    try {
      exitCode = (await proc.exited) ?? 1;
    } catch (err) {
      exitCode = 1;
      fallbackErr = err instanceof Error ? err.message : String(err);
    }

    this.#signal?.removeEventListener('abort', onAbort);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    // Success: caller never reads stdout/stderr, so don't pay for the file
    // reads. On failure or a `proc.exited` reject, surface what we have.
    if (exitCode === 0 && fallbackErr === undefined) {
      return { exitCode, stdout: '', stderr: '' };
    }
    const [stdout, stderr] = await Promise.all([readTruncated(stdoutPath), readTruncated(stderrPath)]);
    return { exitCode, stdout, stderr: fallbackErr ?? stderr };
  }
}

/** Read a file and cap to 50KB with a truncation marker. Missing file → empty string. */
async function readTruncated(filePath: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return '';
    }
    if (file.size > 50_000) {
      const buf = new Uint8Array(await file.slice(0, 50_000).arrayBuffer());
      return new TextDecoder().decode(buf) + '\n... (truncated)';
    }
    return await file.text();
  } catch {
    return '';
  }
}
