# Testing

Transmuter has three layers of tests:

1. **Unit specs** (`*.spec.ts` co-located with source) — the bulk of the coverage.
2. **Real-compiler specs** — scoring, compiler, and rule tests that shell out to real `arm-none-eabi-as`, `agbcc`, and IDO binaries. No mocks.
3. **Fixture tests** (`test-fixture/*/run-*.ts`) — full pipeline runs against real target `.o` files.

## Commands

```bash
pnpm test                                    # run all unit specs (vitest run)
pnpm --filter @transmuter/core run test:watch    # watch mode for core
pnpm --filter @transmuter/cli test               # cli-only specs
pnpm run check-types                         # tsc --noEmit for core + cli
pnpm run lint                                # eslint
pnpm run test:fixture                        # all 7 fixture tests (real compilers)
pnpm run test:fixture -- --fade-out-controller   # single fixture
```

Vitest projects are configured at the monorepo root in `vitest.config.ts` pointing to `packages/core` and `packages/cli`. Each package has its own `vitest.config.ts` that includes `src/**/*.spec.ts`. The webapp has no tests.

## Philosophy — no mocks

This is the **core testing rule**: do not mock compilers, do not mock `objdiff-wasm`, do not mock ast-grep. Tests should shell out to real `arm-none-eabi-as` and real `objdiff-wasm`, and assert against actual ELF objects. The enforced convention is: *write a small assembly or C source, assemble/compile it, run the real code under test against the result.*

Why:
- Mock drift hid real bugs in the mizuchi version of this code for months.
- The scoring layer is tightly coupled to objdiff-wasm's arch-specific behavior (e.g., ARMv4T never emitting op-mismatch). Mocks would lie about this.
- Tests run fast enough (`arm-none-eabi-as` assembles a 2-instruction fixture in milliseconds).

If you're tempted to mock, write a fixture instead. See `packages/core/src/scoring/test-utils.ts` as the canonical example of shared fixture builders.

## Specs layout

```
packages/core/src/
  <area>/
    foo.ts
    foo.spec.ts              # unit test for foo.ts
    test-utils.ts            # shared fixtures for this area (no __fixtures__/ dir)
```

**Shared fixtures live next to the specs in `test-utils.ts`.** Not under `__fixtures__/`, not in a top-level `tests/` directory. Grep `packages/core/src/rules/test-utils.ts` and `packages/core/src/scoring/test-utils.ts` for the two current examples.

## Scoring specs — real assembly fixtures

`packages/core/src/scoring/scorer.spec.ts`, `objdiff.spec.ts`, and `test-utils.ts` shell out to `arm-none-eabi-as`. The helpers:

```ts
import { execSync } from 'child_process';

export function ensureArmToolchain(): void {
  try { execSync('arm-none-eabi-as --version', { stdio: 'pipe' }); }
  catch { throw new Error('arm-none-eabi-as not found in PATH — install the ARM GNU Toolchain before running these tests.'); }
}

export const ARM_DIFF_SETTINGS = {
  'arm.archVersion': 'v4t',
  functionRelocDiffs: 'none',
};

export function armThumbAsm(body: string): string { ... }
export function thumbFunc(name: string, instructions: readonly string[]): string { ... }
export function unsizedThumbFunc(name: string, instructions: readonly string[]): string { ... }
export async function assembleArmThumb(tempDir: string, name: string, source: string): Promise<string> {
  // arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork <sPath> -o <oPath>
}
```

Patterns:

- **`beforeAll`** builds every fixture once (temp dir created with `fs.mkdtemp`), **`afterAll`** cleans up with `fs.rm({ recursive: true, force: true })`.
- **`ensureArmToolchain()`** is called at the top of `beforeAll` for fail-fast error reporting — the message should point at the missing toolchain, not at the first failing assert deep in the spec.
- **Thumb syntax is divided**, not unified: write `add r0, #1`, not `adds r0, #1`. Unified syntax fails `arm-none-eabi-as` in Thumb16 mode.
- **ARMv4T never emits `op-mismatch`.** Mnemonic-only diffs always land in the `replace` bucket. There's an explicit regression note in `scorer.spec.ts` and `objdiff.spec.ts` — don't "fix" these to assert `opMismatch > 0`.
- **`unsizedThumbFunc`** (no `.size` directive) produces ELF symbols with `size = 0` that span to end of section. Used to reproduce the real ROM-extracted "symbol absorbs next function" scenario. See the `detects absorbed instructions when the target symbol has size=0` test.

## Compiler specs — real agbcc / IDO

`packages/core/src/compiler/compiler.spec.ts` resolves paths to `compilers/agbcc/agbcc`, `compilers/ido-static-recomp/build/7.1/out/cc`, and `test-fixture/shared/compile-ido-pascal.sh`. Tests assemble C and Pascal snippets via the real compilers and assert against `CompileResult.success`. A `beforeAll` sanity checks that each binary is present and throws a helpful error if it isn't — users who haven't run `./setup-compilers.sh` get a clear message.

**Don't hardcode absolute paths.** Resolve relative to `__dirname` so the tests work on any clone.

## Rule specs — ast-grep fixtures, no compilation

Rule tests don't need compilers. They parse a C/C++/Pascal snippet, run the rule, and assert on the output string. Boilerplate:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '~/rng.js';
import { parse } from '~/parser.js';
import { myRule } from './my-rule.js';

describe('my-rule', () => {
  it('applies the mutation', () => {
    const source = `void foo(void) { int x = 1; return; }`;
    const root = parse('c', source);
    const rng = new Rng(42);

    const result = myRule.apply({ source, root, rng, functionName: 'foo', language: 'c' });

    expect(result).not.toBeNull();
    expect(result!.source).not.toBe(source);
    expect(result!.location.line).toBeGreaterThan(0);
  });

  it('returns null when no candidates found', () => {
    const source = `void other(void) {}`;
    const root = parse('c', source);
    const rng = new Rng(42);
    expect(myRule.apply({ source, root, rng, functionName: 'foo', language: 'c' })).toBeNull();
  });
});
```

All three grammars (C, C++, Pascal) register synchronously, and `parse(language, source)` auto-registers on first use. Calling `ensureLanguageRegistered` in a `beforeAll` is only useful if you want to surface registration errors up-front rather than on first parse.

## Fixture tests — full pipeline

`test-fixture/<name>/run-<kind>.ts` scripts exercise the full pipeline against a real target `.o`. They're runnable via `pnpm run test:fixture`:

```
test-fixture/
  fade-out-controller/run-permute.ts         # C match (agbcc)
  entity-item-drop/run-multi-branch.ts       # C multi-branch (agbcc)
  fixed-mul8/run-refine.ts                   # C refine — no-asm-pin (agbcc)
  cpp-method-order/run-permute.ts            # C++ match (IDO NCC)
  cpp-cast-cleanup/run-refine.ts             # C++ refine — no-c-style-cast (IDO NCC)
  pascal-power-check/run-permute.ts          # Pascal match (IDO upas)
  pascal-cast-cleanup/run-refine.ts          # Pascal refine — no-redundant-cast-pascal
  shared/
    compile.sh                               # agbcc wrapper
    compile-ido-cpp.sh                       # IDO NCC wrapper
    compile-ido-pascal.sh                    # IDO cc + upas wrapper (handles .pas → .p rename)
    context.h                                # shared GBA types / defs
```

`scripts/run-fixtures.sh` dispatches to each `run-*.ts` via `pnpm tsx`. Running all fixtures takes a minute or two and requires `./setup-compilers.sh` to have been run at least once.

### Adding a new fixture

1. Create `test-fixture/<name>/`.
2. Drop in `base.<ext>` (source) and `target.o` (expected assembly). You'll typically extract the target from a ROM or a reference build.
3. Create `run-<kind>.ts` that constructs a `MutationSearch`, `Refiner`, or `Cleanup`, wires it to a `SessionStore`, and writes the report to `session-*.json`.
4. Use `test-fixture/shared/compile*.sh` as the compiler command template. Pass `cwd` so relative paths in the compile script resolve.
5. Add the fixture to `scripts/run-fixtures.sh`'s `FIXTURE_NAMES` list and the `get_script()` case.
6. Run `pnpm run test:fixture -- --<name>` to confirm.

Fixtures save JSON reports next to the source so the webapp dev-server can load them: `pnpm run dev:webapp -- test-fixture/<name>/session-*.json`.

## Benchmarks

There's no dedicated benchmark harness. Timing-sensitive tests use Vitest's built-in timing (`expect(elapsed).toBeLessThan(…)`) sparingly — most of the suite asserts on functional behavior, not speed.

## Determinism

Every test that involves randomness uses `new Rng(42)` or a seed explicitly passed to `MutationSearch`. The `Rng` is a seeded xoshiro256** PRNG. Different seeds exercise different branches of rules that call `rng.pick()`, so running the suite under several seeds is a good way to catch edge cases before shipping.

## Pitfalls

- **Writing tests that depend on the current working directory.** Resolve paths with `path.resolve(__dirname, '…')`. Relative paths break under vitest's worker model.
- **Skipping `ensureArmToolchain`.** Without the preflight, the first fixture-building `execSync` throws an inscrutable error buried in a fixture-build loop. Run the preflight in `beforeAll` so the failure message points at the root cause.
- **Asserting `opMismatch > 0` on ARM.** It's always 0. Use `replace` instead, and comment the test so the next reader doesn't re-introduce the bug.
- **Mocking `objdiff-wasm` to "speed things up".** Don't. The wasm loader is singleton-cached and costs nothing after the first call. Mocks hide bugs in wasm-specific behavior.
- **Forgetting `afterAll` cleanup** when a spec creates a temp dir. Vitest runs specs in parallel by default and stale temp dirs accumulate fast.
- **Running fixtures without `./setup-compilers.sh`.** You'll get missing-binary errors. The compiler spec's `beforeAll` has a helpful error message; fixtures don't — they'll just fail.
