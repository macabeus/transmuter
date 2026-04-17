import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CompileResult } from '~/types.js';

import { Compiler } from './compiler.js';

const COMPILERS_DIR = path.resolve(__dirname, '../../../../compilers');
const AGBCC = path.join(COMPILERS_DIR, 'agbcc/agbcc');
const IDO_CC = path.join(COMPILERS_DIR, 'ido-static-recomp/build/7.1/out/cc');
const IDO_PASCAL_SCRIPT = path.resolve(__dirname, '../../../../test-fixture/shared/compile-ido-pascal.sh');

/** agbcc outputs .s, so we assemble with arm-none-eabi-as to get .o */
const AGBCC_COMMAND = `${AGBCC} -O2 -o {{outputPath}}.s {{inputPath}} && arm-none-eabi-as -mcpu=arm7tdmi -o {{outputPath}} {{outputPath}}.s`;
const IDO_COMMAND = `${IDO_CC} -O2 -mips2 -c -o {{outputPath}} {{inputPath}}`;
/** IDO's cc routes files to the upas (Pascal) frontend via .p extension — the shared script handles the rename. */
const IDO_PASCAL_COMMAND = `bash ${IDO_PASCAL_SCRIPT} {{inputPath}} {{outputPath}}`;

const VALID_C_SOURCE = `int foo(void) { return 42; }`;
const COMPILE_ERROR_SOURCE = `this is not valid C code!!!`;
const MULTI_FUNC_SOURCE = `
int helper(int x) { return x + 1; }
int foo(int a) { return helper(a); }
`;
const VALID_PASCAL_SOURCE = `procedure update_coords(var a: Integer; var b: Integer; da: Integer; db: Integer);
begin
  b := b + db;
  a := a + da;
end;
`;

type SuccessfulCompile = Extract<CompileResult, { success: true }>;

/** Asserts a compile succeeded, throwing with the compiler error if it didn't. */
function expectOk(r: CompileResult): asserts r is SuccessfulCompile {
  if (!r.success) {
    throw new Error(`expected compile success, got error: ${r.error}`);
  }
}

describe('Compiler', () => {
  const compilers: Compiler[] = [];

  function createCompiler(opts: ConstructorParameters<typeof Compiler>[0]): Compiler {
    const compiler = new Compiler(opts);
    compilers.push(compiler);
    return compiler;
  }

  beforeAll(async () => {
    for (const [name, p] of [
      ['agbcc', AGBCC],
      ['ido cc', IDO_CC],
      ['ido pascal script', IDO_PASCAL_SCRIPT],
    ] as const) {
      try {
        await fs.access(p);
      } catch {
        throw new Error(
          `Missing test fixture: ${name} not found at ${p}. Run ./setup-compilers.sh before running these tests.`,
        );
      }
    }
  });

  afterEach(async () => {
    for (const c of compilers) {
      await c.destroy();
    }
    compilers.length = 0;
  });

  // ---------------------------------------------------------------------------
  // Happy path — agbcc
  // ---------------------------------------------------------------------------

  describe('agbcc', () => {
    it('compiles valid C source to an object file', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);

      expectOk(result);
      expect(result.objPath).toMatch(/output-0\.o$/);
      const stat = await fs.stat(result.objPath);
      expect(stat.size).toBeGreaterThan(0);
    });

    it('compiles multi-function source', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile(MULTI_FUNC_SOURCE);
      expectOk(result);
    });

    it('increments file counter across compilations', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const r1 = await compiler.compile(VALID_C_SOURCE);
      const r2 = await compiler.compile(VALID_C_SOURCE);

      expectOk(r1);
      expectOk(r2);
      expect(r1.objPath).toContain('output-0');
      expect(r2.objPath).toContain('output-1');
      // Both exist independently.
      await fs.access(r1.objPath);
      await fs.access(r2.objPath);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path — IDO
  // ---------------------------------------------------------------------------

  describe('ido', () => {
    it('compiles valid C source to an ELF object', async () => {
      const compiler = createCompiler({
        command: IDO_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);

      expectOk(result);
      const stat = await fs.stat(result.objPath);
      expect(stat.size).toBeGreaterThan(0);
    });

    it('compiles valid Pascal source to a MIPS object file', async () => {
      const compiler = createCompiler({
        command: IDO_PASCAL_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'update_coords',
        language: 'pascal',
      });

      const result = await compiler.compile(VALID_PASCAL_SOURCE);

      expectOk(result);
      expect(result.objPath).toMatch(/output-0\.o$/);
      const stat = await fs.stat(result.objPath);
      expect(stat.size).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Source prefix
  // ---------------------------------------------------------------------------

  describe('source prefix', () => {
    it('prepends sourcePrefix to the source before compilation', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
        sourcePrefix: 'typedef unsigned int u32;\n',
      });

      const result = await compiler.compile('u32 foo(void) { return 42; }');
      expectOk(result);
    });

    it('fails when type is used without the prefix', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
        // No sourcePrefix
      });

      const result = await compiler.compile('u32 foo(void) { return 42; }');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Language extensions
  // ---------------------------------------------------------------------------

  describe('language extension', () => {
    it('uses .c extension by default', async () => {
      const compiler = createCompiler({
        command: `case "{{inputPath}}" in *.c) cp {{inputPath}} {{outputPath}} ;; *) exit 1 ;; esac`,
        cwd: '/tmp',
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);
      expectOk(result);
    });

    it('uses .cpp extension for C++', async () => {
      const compiler = createCompiler({
        command: `case "{{inputPath}}" in *.cpp) cp {{inputPath}} {{outputPath}} ;; *) exit 1 ;; esac`,
        cwd: '/tmp',
        functionName: 'foo',
        language: 'cpp',
      });

      const result = await compiler.compile('int foo() { return 1; }');
      expectOk(result);
    });

    it('uses .pas extension for Pascal', async () => {
      const compiler = createCompiler({
        command: `case "{{inputPath}}" in *.pas) cp {{inputPath}} {{outputPath}} ;; *) exit 1 ;; esac`,
        cwd: '/tmp',
        functionName: 'foo',
        language: 'pascal',
      });

      const result = await compiler.compile('program foo; begin end.');
      expectOk(result);
    });
  });

  // ---------------------------------------------------------------------------
  // Template variable substitution
  // ---------------------------------------------------------------------------

  describe('template substitution', () => {
    it('substitutes {{functionName}} in the command', async () => {
      const compiler = createCompiler({
        command: `echo "{{functionName}}" > {{outputPath}}`,
        cwd: '/tmp',
        functionName: 'my_function',
      });

      const result = await compiler.compile('');
      expectOk(result);
      const content = await fs.readFile(result.objPath, 'utf-8');
      expect(content.trim()).toBe('my_function');
    });
  });

  // ---------------------------------------------------------------------------
  // Compilation errors
  // ---------------------------------------------------------------------------

  describe('compilation errors', () => {
    it('returns error with compiler diagnostics on invalid source', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile(COMPILE_ERROR_SOURCE);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
        expect(result.error.length).toBeGreaterThan(0);
      }
    });

    it('returns error when compiler command does not exist', async () => {
      const compiler = createCompiler({
        command: '/nonexistent/compiler -o {{outputPath}} {{inputPath}}',
        cwd: '/tmp',
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });

    it('returns error when compiler produces no output file', async () => {
      // Command succeeds (exit 0) but does not create the output file
      const compiler = createCompiler({
        command: 'echo "no output created"',
        cwd: '/tmp',
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Compiler produced no output file');
      }
    });

    it('reports exit code when compiler fails with no output', async () => {
      const compiler = createCompiler({
        command: 'exit 42',
        cwd: '/tmp',
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('42');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stdout / stderr truncation
  // ---------------------------------------------------------------------------

  describe('output truncation', () => {
    it('truncates very large stderr without hanging', async () => {
      // Write 200 KB to stderr (well over the 64 KB pipe buffer and the 50 KB
      // cap), then exit 1. The classic bug: `removeAllListeners('data')`
      // reverts the stream to paused mode, and a chatty child then deadlocks
      // on a full pipe buffer.
      const compiler = createCompiler({
        command: `head -c 200000 /dev/zero 1>&2; exit 1`,
        cwd: '/tmp',
        functionName: 'foo',
      });

      const start = Date.now();
      const result = await compiler.compile(VALID_C_SOURCE);
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      if (!result.success) {
        // 50 KB cap + the "... (truncated)" suffix
        expect(result.error.length).toBeLessThan(55_000);
        expect(result.error.length).toBeGreaterThan(49_000);
      }
      // No deadlock — this should complete in well under a second.
      expect(elapsed).toBeLessThan(5_000);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Abort signal
  // ---------------------------------------------------------------------------

  describe('abort signal', () => {
    it('returns aborted immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
        signal: controller.signal,
      });

      const result = await compiler.compile(VALID_C_SOURCE);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Aborted');
      }
    });

    it('kills running compilation when signal fires', async () => {
      const controller = new AbortController();

      const compiler = createCompiler({
        // exec replaces the shell with sleep, so SIGTERM reaches it directly
        command: 'exec sleep 30',
        cwd: '/tmp',
        functionName: 'foo',
        signal: controller.signal,
      });

      const promise = compiler.compile(VALID_C_SOURCE);

      // Abort shortly after starting
      setTimeout(() => controller.abort(), 100);

      const result = await promise;

      expect(result.success).toBe(false);
    }, 10_000);

    it('kills grandchildren, not just the shell (process group signal)', async () => {
      // Without `detached: true` + `kill(-pgid)`, SIGTERM lands only on /bin/sh
      // and the `sleep` grandchild keeps running — its open pipe fds keep the
      // `close` event from firing, and compile() would hang for a full 30 s.
      const controller = new AbortController();

      const compiler = createCompiler({
        command: 'sleep 30',
        cwd: '/tmp',
        functionName: 'foo',
        signal: controller.signal,
      });

      const start = Date.now();
      const promise = compiler.compile(VALID_C_SOURCE);
      setTimeout(() => controller.abort(), 100);

      const result = await promise;
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      // Should return in well under 30 seconds; 3 s is ample headroom.
      expect(elapsed).toBeLessThan(3_000);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Concurrent compilations
  // ---------------------------------------------------------------------------

  describe('concurrent compilations', () => {
    it('handles multiple compilations in parallel without file collisions', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const sources = [
        'int foo(void) { return 1; }',
        'int foo(void) { return 2; }',
        'int foo(void) { return 3; }',
        'int foo(void) { return 4; }',
      ];

      const results = await Promise.all(sources.map((s) => compiler.compile(s)));

      for (const result of results) {
        expectOk(result);
      }

      // All output paths should be unique
      const paths = results.filter((r) => r.success).map((r) => (r as SuccessfulCompile).objPath);
      const unique = new Set(paths);
      expect(unique.size).toBe(sources.length);
    });

    it('does not leak temp dirs when parallel compiles race #ensureTmpDir', async () => {
      // Regression for the old `#tmpDir: string | null` cache: parallel compiles
      // all observed `null` and each called mkdtemp(), leaking N-1 directories
      // that `destroy()` never reached. The fix caches a single Promise.
      // NB: we diff before/after around this specific compiler, but other
      // tests (and worker subprocess tests) can create `transmuter-*` dirs in
      // parallel — so we enforce the "no leak" invariant on this compiler's
      // own delta, not the total count.
      const isCompilerTmpDir = (d: string) => /^transmuter-[a-zA-Z0-9]+$/.test(d);
      const tmpRoot = os.tmpdir();
      const before = new Set((await fs.readdir(tmpRoot)).filter(isCompilerTmpDir));

      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      // Fire many compiles in parallel — all from a single synchronous `.map`,
      // ensuring they all pass through #ensureTmpDir before any mkdtemp resolves.
      const sources = Array.from({ length: 8 }, (_, i) => `int foo(void) { return ${i}; }`);
      await Promise.all(sources.map((s) => compiler.compile(s)));

      const afterCompile = (await fs.readdir(tmpRoot)).filter(isCompilerTmpDir);
      const newDirsFromThisCompiler = afterCompile.filter((d) => !before.has(d));
      // Exactly one dir per this compiler (the regression: was 8 with the old code).
      expect(newDirsFromThisCompiler.length).toBeGreaterThanOrEqual(1);
      expect(newDirsFromThisCompiler.length).toBeLessThan(sources.length);

      // And destroy() should remove this compiler's own dir (others from
      // concurrent tests may remain).
      const ownDir = newDirsFromThisCompiler[0]!;
      await compiler.destroy();
      const afterDestroy = new Set((await fs.readdir(tmpRoot)).filter(isCompilerTmpDir));
      expect(afterDestroy.has(ownDir)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup and destroy
  // ---------------------------------------------------------------------------

  describe('cleanup and destroy', () => {
    it('Compiler.cleanup() removes a specific object file', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);
      expectOk(result);
      await Compiler.cleanup(result.objPath);
      await expect(fs.access(result.objPath)).rejects.toThrow();
    });

    it('Compiler.cleanup() does not throw on non-existent file', async () => {
      await expect(Compiler.cleanup('/tmp/nonexistent-file-12345.o')).resolves.not.toThrow();
    });

    it('destroy() removes the temp directory', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile(VALID_C_SOURCE);
      expectOk(result);
      const tmpDir = path.dirname(result.objPath);

      await compiler.destroy();

      await expect(fs.access(tmpDir)).rejects.toThrow();
    });

    it('destroy() is safe to call multiple times', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      await compiler.compile(VALID_C_SOURCE);
      await compiler.destroy();
      await expect(compiler.destroy()).resolves.not.toThrow();
    });

    it('destroy() is safe to call without any compilations', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      await expect(compiler.destroy()).resolves.not.toThrow();
    });

    it('destroy() waits for in-flight compiles before wiping the tmp dir', async () => {
      // A slow command: sleep, then write some output. If destroy() does NOT
      // wait, the compile finds its tmpdir gone mid-write and returns an error.
      const compiler = createCompiler({
        command: `sleep 0.3 && echo done > {{outputPath}}`,
        cwd: '/tmp',
        functionName: 'foo',
      });

      const compilePromise = compiler.compile(VALID_C_SOURCE);
      // Start destroy while the compile is still running.
      const destroyPromise = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        await compiler.destroy();
      })();

      const [result] = await Promise.all([compilePromise, destroyPromise]);
      expectOk(result);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Temp directory reuse
  // ---------------------------------------------------------------------------

  describe('temp directory reuse', () => {
    it('uses the same temp directory across compilations', async () => {
      const compiler = createCompiler({
        command: AGBCC_COMMAND,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const r1 = await compiler.compile(VALID_C_SOURCE);
      const r2 = await compiler.compile(VALID_C_SOURCE);

      expectOk(r1);
      expectOk(r2);
      expect(path.dirname(r1.objPath)).toBe(path.dirname(r2.objPath));
    });
  });

  // ---------------------------------------------------------------------------
  // Working directory
  // ---------------------------------------------------------------------------

  describe('working directory', () => {
    it('executes compiler in the specified cwd', async () => {
      const compiler = createCompiler({
        command: `pwd > {{outputPath}}`,
        cwd: COMPILERS_DIR,
        functionName: 'foo',
      });

      const result = await compiler.compile('');
      expectOk(result);
      const content = await fs.readFile(result.objPath, 'utf-8');
      expect(content.trim()).toBe(COMPILERS_DIR);
    });
  });
});
