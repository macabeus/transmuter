# CLAUDE.md

Transmuter — a TypeScript library + CLI that permutes C / C++ / Pascal source code to match target assembly, and refines already-matching code to remove code smells.

## Commands

All commands run from the repo root. **Package manager is pnpm** (workspace protocol). Never use `npm` or `yarn`.

```bash
pnpm install                               # install all workspaces
pnpm run build                             # build all packages (pnpm -r run build)
pnpm run check-types                       # tsc --noEmit for core + cli
pnpm run lint                              # eslint packages/
pnpm run format                            # prettier write
pnpm test                                  # vitest run (core + cli projects)
pnpm --filter @transmuter/core run test:watch
pnpm run test:fixture                      # run all 7 real-compiler fixtures
pnpm run test:fixture -- --fade-out-controller   # single fixture

# Core package dev (watch build, no DTS)
pnpm --filter @transmuter/core run build:esm
pnpm --filter @transmuter/core run dev     # bun --watch run build.ts

# CLI — dev mode auto-builds core first (predev hook)
pnpm --filter @transmuter/cli run dev -- match path/to/source.c

# Webapp
pnpm run build:webapp                      # single-file HTML bundle
pnpm run dev:webapp -- ./session-report.json   # live dev with a report JSON

# Compiler toolchains (one-time, required for fixtures + real runs)
./setup-compilers.sh                       # builds agbcc + IDO 7.1 submodules
```

## Package map

| Package | Path | What it is | Entry point |
|---|---|---|---|
| `@transmuter/core` | `packages/core/` | Search engine, rules, guidelines, scoring, session store. Published library. | `src/index.ts` |
| `@transmuter/cli` | `packages/cli/` | `transmuter` binary — Ink TUI + Hono HTTP control server. | `src/index.ts` |
| `@transmuter/webapp` | `packages/webapp/` | Static React single-file bundle for viewing `SessionReport`/`RefinementReport` JSON. Private. | `src/main.tsx` (via `vite.config.ts`) |

CLI commands: `match`, `refine`, `profile-detect`, `ctl`. There is no standalone `reduce` or `rules` subcommand — the reducer runs as the pre-step of `match` (skip with `--no-reduce`), and rules are listed via `profile-detect`.

## Architecture summary

- **Core pipeline**: `MutationSearch` runs N concurrent slots. Each slot loop = `pool.select() → engine.mutate() → dedup → compile → scorer.scoreWithAssembly() → pool.report() → emit events`. Bottleneck is compilation (subprocesses via `Compiler` class).
- **Candidate graph**: `Pool` manages a tree of immutable `CandidateNode`s connected by `parentId`. On score improvement, the pool **forks** — creates a new candidate + new `MutationTarget`. The parent target keeps exploring. Fork dedup tuple: `(scoreDelta, ruleId, line, column)`. Genesis never mutates in place.
- **Rules vs guidelines**: Rules (49 built-in) are mutation plugins selected by weighted Thompson Sampling filtered by diff-type affinity. Guidelines (4 built-in) detect a `Violation`, know how to strip it, and drive `Refiner` sub-sessions that re-match while preventing re-introduction.
- **Scoring**: `Scorer` wraps `objdiff-wasm`. `scoreWithAssembly()` returns `{ score, breakdown: DiffBreakdown, assembly, assemblyDiff }` in one pass. `DiffBreakdown` = insert + delete + replace + opMismatch + argMismatch.
- **Session report**: `SessionStore` captures `MutationSearchEvent`s, produces a `SessionReport` JSON consumed by the webapp. `RefinementStore` plays the same role for `transmuter refine`.
- **HTTP API**: `--api` starts a Hono server on localhost with common read/control endpoints + mode-specific extras. Writes a `transmuter-control.json` discovery file. `transmuter ctl` is the client.

For the full design, read `.claude/docs/architecture.md`.

## Key conventions

- **pnpm workspaces.** `workspace:*` for internal deps. Lockfile is `pnpm-lock.yaml`.
- **Path alias `~` → `./src`** inside each package (not a global alias — each package's `tsconfig.json` declares its own). The webapp uses `@core` → `../core/src` to import core types/helpers directly from source (no built package needed for the webapp to compile).
- **ESM only.** `"type": "module"` everywhere. Imports must end in `.js` even for TS files (`import x from './foo.js';`).
- **Strict TS.** `strict`, `strictNullChecks`, `noUncheckedIndexedAccess`. Writing array/map access without a null check is a type error.
- **Test files**: `*.spec.ts` co-located with the source file. Shared fixtures live in `test-utils.ts` next to the specs (not under `__fixtures__/`).
- **No mocks.** Scoring/compiler tests shell out to the real `arm-none-eabi-as`, run real `objdiff-wasm`, and build real ELF objects. Follow this for any new scoring/compiler test.
- **Rule/guideline plugins** are plain exported objects implementing `Rule` / `Guideline`. They declare `languages: readonly Language[]` (`'c' | 'cpp' | 'pascal'`) — the engine filters by language automatically. Register in `packages/core/src/rules/built-in/index.ts` or `packages/core/src/guidelines/built-in/index.ts`.
- **Terms are stable.** Every term in the glossary (`candidate`, `target`, `fork`, `genesis`, `organic`, `supernode`, `violation`…) means exactly the same thing in code, docs, tests, and UI. Don't invent synonyms.

## Non-obvious gotchas

- **Never mutate a `CandidateNode`.** They are immutable snapshots. Improvements create new nodes via `pool.report()` — never reach into `#candidates` and edit a field.
- **`objdiff-wasm` init is a per-process singleton.** `scoring/scorer.ts` → `initObjdiff()` lazily loads the WASM and the result is shared across all `Scorer` / `Objdiff` instances. Don't call `initObjdiff` yourself — go through `Scorer` / `Objdiff` so they share the singleton.
- **On ARMv4T, `op-mismatch` is never produced.** objdiff classifies every mnemonic-only diff as `replace`. `opMismatch` is effectively MIPS-only. Write tests accordingly — see the note in `packages/core/src/scoring/scorer.spec.ts`.
- **IDO Pascal lowercases all symbol names.** `IsPowerOfTwo` → `ispoweroftwo` in the ELF. Pascal rule helpers match function names case-insensitively. Don't "fix" them to be case-sensitive.
- **Unsized symbols span to end of section.** If a `.s` fixture lacks a `.size` directive, objdiff treats the symbol as covering everything after its label. Real ROM-extracted targets hit this — there's a regression test in `scoring/objdiff.spec.ts`.
- **Refine "exhausted" ≠ "impossible".** Phase-1 sub-searches cap at `maxUnproductiveIterations: 100_000` — if the `candidateFilter` rejects every mutation for that long, the violation transitions to `'transmuter-exhausted'`. Bump the limit before concluding that a violation can't be fixed.
- **Auto-compact silently summarizes dead branches into `SuperNode`s.** If you expect to find a specific candidate by ID and it's gone, check `store.getGraph().superNodes` — it may have been compacted. Disable with `autoCompact: false`.
- **`transmuter dev` wants core built first.** The CLI's `predev` hook runs `@transmuter/core`'s `build:esm`. If you edit core and run the CLI with `pnpm start`, you're running the stale `dist/`. Use `pnpm --filter @transmuter/cli run dev` or rebuild core explicitly.
- **Divided Thumb syntax** in assembly fixtures: write `add r0, #1` (implicit flag-set on low regs), not unified `adds r0, #1` — `arm-none-eabi-as` rejects the unified form in Thumb16 mode.

## Doc index

All topic docs live in `.claude/docs/`. Read on-demand.

- [architecture.md](.claude/docs/architecture.md) — full design spec: glossary, pipeline, types, events. **Read when:** you need a deep understanding of how pieces fit together, or you're onboarding for a non-trivial change.
- [mutation-plugins.md](.claude/docs/mutation-plugins.md) — how to write a mutation rule, the `Rule` interface, ast-grep patterns, registration. **Read when:** adding or modifying a mutation rule.
- [guideline-plugins.md](.claude/docs/guideline-plugins.md) — how guidelines differ from rules, the detect/remove/containsViolation trio. **Read when:** adding a refinement guideline.
- [candidate-graph.md](.claude/docs/candidate-graph.md) — Pool, forks, dedup, lineage, lateral forks, auto-compact, supernodes. **Read when:** touching `pipeline/pool.ts`, `search/auto-compact.ts`, or anything that stores/queries candidates.
- [report-store.md](.claude/docs/report-store.md) — `SessionStore` + `RefinementStore` event capture, query API, JSON schema, how `SessionReport` flows to the webapp. **Read when:** adding a new event, a new store query, or touching the report JSON format.
- [http-api.md](.claude/docs/http-api.md) — every control-server endpoint, request/response shapes, the `transmuter ctl` client, discovery file. **Read when:** extending the HTTP API or integrating an external agent.
- [multi-language.md](.claude/docs/multi-language.md) — language detection, grammar registration, Pascal node-kind map, how a new language plugs in. **Read when:** adding a language or writing a Pascal-specific rule.
- [refine-mode.md](.claude/docs/refine-mode.md) — Phase 1 parallel explore + Phase 2 sequential merge, trivial-fix short-circuit, injection-based fixes, `--constraints`. **Read when:** touching the `Refiner`, adding a guideline, or debugging a refine run.
- [webapp.md](.claude/docs/webapp.md) — React+Vite structure, `@xyflow/react` graph, how report JSON flows in, dev-server data injection. **Read when:** adding a view, tweaking the graph, or shipping a new report field.
- [testing.md](.claude/docs/testing.md) — Vitest layout, the real-compiler philosophy, `test-utils.ts` helpers, how to add a fixture test. **Read when:** adding tests or fixing a flaky one.
- [cleanup-and-reduce.md](.claude/docs/cleanup-and-reduce.md) — two-phase cleanup (canonicalize + smell permute) and the library-only reducer. **Read when:** changing smell scoring or touching canonicalizer passes.
- [mizuchi-integration.md](.claude/docs/mizuchi-integration.md) — current state of Mizuchi ↔ Transmuter (mostly aspirational — only the objdiff wrapper is ported). **Read when:** wiring Mizuchi to consume Transmuter as a plugin.
