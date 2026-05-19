# Transmuter Architecture

A TypeScript library and CLI for permuting C, C++, and Pascal source code to match target assembly. Spiritual successor to [decomp-permuter](https://github.com/simonlindholm/decomp-permuter), rewritten from scratch.

---

## Glossary

Every term below is used identically in code, documentation, and UI. No synonyms.

| Term | Definition |
|------|-----------|
| **Language** | A supported source language: `'c'`, `'cpp'`, or `'pascal'`. Detected automatically from the file extension. Type: `Language` |
| **Mutation** | A single transformation applied to source code |
| **Rule** | A plugin that defines one type of mutation. Interface: `Rule`. Returns `MutationApplyResult` with the mutated source and the AST location targeted. Each rule declares which languages it supports via the `languages` field |
| **Candidate** | An immutable snapshot of source code with its score and assembly. Type: `CandidateNode`. Once created, never modified |
| **Genesis** | The initial input code. A `CandidateNode` with `origin: 'genesis'`. Root of the candidate graph, always preserved |
| **Score** | The objdiff difference count for a candidate, decomposed into a `DiffBreakdown` with per-type counts (insert, delete, replace, opMismatch, argMismatch). Lower = better, 0 = perfect match |
| **Fork** | When a mutation improves the score, the improved code becomes a new candidate on a new mutation target. The parent is preserved and continues being mutated |
| **Mutation Target** | A candidate being actively targeted for mutations. Type: `MutationTarget`. Points to a candidate (never changes), carries scheduling weight and attempt count |
| **Pool** | Manages the candidate graph and mutation targets. Handles fork-on-improvement with dedup, weighted selection, and target enable/disable |
| **Slot** | A concurrent match worker. Each slot runs: select target -> mutate -> compile -> score -> report |
| **Profile** | Compiler-specific configuration: default rule weights, disabled rules, auto-detection |
| **Reduction** | Minimizing a source file while preserving assembly output |
| **Guideline** | A plugin that detects a code smell and defines how to remove it. Used by `transmuter refine`. Each guideline declares which languages it supports via the `languages` field |
| **Violation** | An instance of a code smell detected by a guideline |
| **Refinement** | Improving code quality of already-matching code by removing violations while preserving the match |
| **DiffBreakdown** | Structured decomposition of the assembly diff score by type: insert, delete, replace, opMismatch, argMismatch. Stored on every `CandidateNode` |
| **Diff type affinity** | Rules can declare which diff types they're relevant for via `relevantDiffTypes: ReadonlySet<DiffType>`. Rules irrelevant to the current candidate's breakdown are excluded from selection |
| **Adaptive selection** | Per-target Thompson Sampling that learns which rules are effective for each mutation target. Always enabled; pass `AdaptiveSelectorOptions` to tune window size |
| **Exhausted** | A search that stopped because `maxUnproductiveIterations` was reached without a single compilation. Happens when a `candidateFilter` rejects all mutations (e.g., refine mode for asm constructs). `MutationSearchResult.reason: 'exhausted'` |
| **SuperNode** | A summary node replacing a dead-end subtree of pruned candidates. Preserves aggregate statistics (candidate count, best/worst score, best source, rules used) without retaining the individual candidates in memory. Type: `SuperNode` |
| **Graph summarization** | The process of replacing dead-end candidate subtrees with supernodes to free memory. Runs automatically when branches are pruned or auto-compacted. Uses depth-0 compaction: includes the branch root in the supernode (frees its memory), and the supernode's `parentId` points to the branch root's reachable parent. Handles multi-root forests (external injections create additional roots) |
| **Auto-compact** | Automatic pruning and compaction of dead branches during the search. Enabled by default. Two strategies: (1) **Population-based** — when `activeTargets > keepN * 3` (where `keepN = max(keepMinTargets, concurrency * 5)`), keeps only the best N targets by score and disables the rest. This creates entire dead subtrees that `summarize()` can free, and works even in high-fork-rate sessions (e.g., refine). (2) **Staleness-based** — for smaller pools, uses an adaptive threshold: `effective = max(minStaleThreshold, staleAfterAttempts / sqrt(activeTargets / concurrency))`. Population-based fires first (priority). Both strategies are **self-stabilizing**: pruning shrinks the pool, which raises the threshold, which stops pruning. Configured via `AutoCompactPolicy` on `MutationSearchOptions`. The check only fires when `candidateCount >= candidateThreshold` (default: 200) |
| **Cleanup** | Post-match source simplification. Two phases: (1) deterministic AST canonicalization, (2) smell-budget mutation loop. Hard constraint: compiled assembly must stay identical (score 0) |
| **Canonicalization** | Phase 1 of cleanup: fast, deterministic AST passes (unwrap `do-while(0)`, eliminate dead variables, inline single-use variables, remove redundant casts, normalize whitespace) |
| **Smell score** | A weighted count of code smells (temp variables, casts, `do-while(0)`, single-use variables, statement count). Lower = cleaner. Used as the optimization target in cleanup Phase 2 |

---

## 1. Package Layout

Monorepo with three packages, managed by pnpm workspaces:

```
transmuter/
├── packages/
│   ├── core/                           # @transmuter/core
│   │   ├── src/
│   │   │   ├── index.ts                # Public API exports
│   │   │   ├── mutation-search.ts       # Main orchestrator class
│   │   │   ├── types.ts                # All shared types
│   │   │   ├── language.ts             # Language type, detection, EXTENSION_MAP
│   │   │   ├── pipeline/
│   │   │   │   ├── pool.ts             # Candidate graph + mutation target management
│   │   │   │   └── deduplicator.ts     # Source hash deduplication (Bun.hash / Wyhash)
│   │   │   ├── search/
│   │   │   │   ├── mutation-search.ts  # Top-level search entry
│   │   │   │   ├── slot-orchestrator.ts# Spawns N worker threads, dispatches jobs, collects results
│   │   │   │   ├── worker-protocol.ts  # Typed init/job/result/event envelopes for workers
│   │   │   │   ├── slot-worker.ts      # Worker entry: full mutate→dedup→compile→score per job
│   │   │   │   └── auto-compact.ts     # Population/staleness pruning policy
│   │   │   ├── rules/
│   │   │   │   ├── rule.ts             # Rule interface (returns MutationApplyResult)
│   │   │   │   ├── registry.ts         # Rule registry (register, enable, disable, weights)
│   │   │   │   ├── engine.ts           # Applies mutations (weighted selection, location tracking)
│   │   │   │   ├── adaptive-selector.ts # Per-target Thompson Sampling for rule selection
│   │   │   │   ├── helpers.ts          # Shared AST utilities for rules (C/C++/Pascal)
│   │   │   │   ├── pascal-helpers.ts   # Pascal-specific AST helpers
│   │   │   │   └── built-in/           # 49 built-in mutation rules
│   │   │   ├── guidelines/
│   │   │   │   ├── guideline.ts        # Guideline interface (detect, remove, containsViolation)
│   │   │   │   ├── registry.ts         # Guideline registry
│   │   │   │   └── built-in/           # Built-in guidelines (4 total)
│   │   │   ├── refiner/
│   │   │   │   ├── refiner.ts          # Refiner class (Phase 1 explore + Phase 2 merge)
│   │   │   │   └── refiner-store.ts    # RefinementStore (event capture + report)
│   │   │   ├── cleanup/
│   │   │   │   ├── cleanup.ts          # Cleanup orchestrator (Phase 1 canonicalize + Phase 2 smell permute)
│   │   │   │   ├── canonicalizer.ts    # Deterministic AST simplification passes
│   │   │   │   └── smell.ts            # AST-based smell scorer (temp vars, casts, do-while(0), etc.)
│   │   │   ├── scoring/
│   │   │   │   ├── scorer.ts           # Scorer (score + scoreWithAssembly + assemblyDiff)
│   │   │   │   └── objdiff.ts          # Objdiff wrapper (parse, diff, assembly extraction)
│   │   │   ├── compiler/
│   │   │   │   └── compiler.ts         # Shell script compilation wrapper (language-aware file extensions)
│   │   │   ├── reducer/
│   │   │   │   └── reducer.ts          # Source reduction algorithm
│   │   │   ├── session/
│   │   │   │   ├── store.ts            # SessionStore (event capture, graph queries, report)
│   │   │   │   ├── collapsed-graph.ts  # Collapsed DAG spine (winning lineage + off-spine clusters)
│   │   │   │   └── node-filter.ts      # CompositeNodeFilter for focus/avoid constraints
│   │   │   ├── profiles/
│   │   │   │   └── profile.ts          # Profile interface + built-in profiles
│   │   │   ├── parser.ts              # Multi-language ast-grep parser setup
│   │   │   └── rng.ts                  # Seeded PRNG (xoshiro256**)
│   │   └── package.json
│   ├── cli/                            # @transmuter/cli
│   │   ├── src/
│   │   │   ├── index.ts                # CLI entry point (match, refine, reduce, rules, ctl)
│   │   │   ├── api/
│   │   │   │   └── server.ts           # HTTP control server (Hono JSON API on localhost)
│   │   │   ├── commands/
│   │   │   │   ├── match.tsx            # Match command with live dashboard
│   │   │   │   ├── refine.tsx          # Code quality refinement command
│   │   │   │   ├── reduce.tsx          # Source reduction command
│   │   │   │   ├── rules.tsx           # List available rules
│   │   │   │   └── ctl.ts             # HTTP client for the control server
│   │   │   ├── components/
│   │   │   │   └── dashboard.tsx       # Shared live progress dashboard
│   │   │   ├── bridge.ts              # Wires MutationSearch events to Ink state
│   │   │   └── config.ts              # decomp.yaml loader
│   │   └── package.json
│   └── webapp/                         # @transmuter/webapp
│       ├── src/
│       │   ├── App.tsx                 # Main app (routes match vs refinement)
│       │   ├── RefinementApp.tsx       # Refinement report viewer
│       │   └── components/
│       │       ├── CandidateGraph.tsx  # @xyflow/react graph visualization
│       │       ├── CodeBlock.tsx       # Syntax-highlighted code (C, C++, Pascal, asm, diff)
│       │       ├── SessionSummary.tsx  # Summary statistics
│       │       ├── ScoreTimeline.tsx   # Score over time chart
│       │       ├── RuleEffectiveness.tsx # Rule stats table
│       │       ├── FocusResults.tsx    # Focus constraint results
│       │       ├── RefinementSummary.tsx
│       │       ├── ViolationList.tsx   # Violations with sub-session drill-down
│       │       ├── MergeTimeline.tsx
│       │       └── ResultViewer.tsx
│       └── package.json
├── compilers/                         # Compiler submodules (built via setup-compilers.sh)
│   ├── agbcc/                        # GBA C compiler (git submodule: pret/agbcc)
│   └── ido-static-recomp/           # N64 IDO 7.1 (git submodule: decompals/ido-static-recomp)
├── test-fixture/                       # Test fixtures with real compilers
│   ├── fade-out-controller/          # C match test (agbcc)
│   ├── fixed-mul8/                    # C refine test — asm pin removal (agbcc)
│   ├── entity-item-drop/             # C multi-branch test (agbcc)
│   ├── cpp-method-order/             # C++ match test (IDO NCC)
│   ├── cpp-cast-cleanup/             # C++ refine test — C-style cast removal (IDO NCC)
│   ├── pascal-power-check/           # Pascal match test (IDO cc + upas)
│   ├── pascal-cast-cleanup/          # Pascal refine test — redundant cast removal (IDO cc + upas)
│   └── shared/                       # Shared compile scripts + context.h
│       ├── compile.sh               # agbcc (GBA ARM) compiler wrapper
│       ├── compile-ido-cpp.sh       # IDO NCC (C++) compiler wrapper
│       └── compile-ido-pascal.sh    # IDO cc + upas (Pascal) compiler wrapper
├── scripts/
│   └── run-fixtures.sh               # Runs all or a single test fixture
├── docs/                              # Guides for extending Transmuter
│   ├── adding-a-language.md
│   ├── adding-rules.md
│   ├── adding-guidelines.md
│   └── adding-profiles.md
├── setup-compilers.sh                 # Downloads submodules and builds compilers
├── package.json                       # Workspace root (pnpm)
└── ARCHITECTURE.md                    # This document
```

### Runtime

Transmuter runs **only on [Bun](https://bun.com)** (pinned via `engines.bun: ">=1.3.12"` in every workspace `package.json`). Node.js is not supported — the code deliberately calls `Bun.spawn`, `Bun.file`, `Bun.hash`, `Bun.serve` etc. where it matters, and several Node-only shims (the `globalThis.fetch` monkey-patch for `file://` URLs, `@hono/node-server`, `http.request` in `ctl`) have been removed.

Bun's relevance at specific hot spots:

| Site | Bun API | Why |
|------|---------|-----|
| `Compiler.#exec` | `Bun.spawn` with fd stdio (`stdio: ['ignore', stdoutFd, stderrFd]`) | Wine/mwcc writes stderr through a pipe extremely slowly on macOS (~5 s per compile); fd stdio avoids this. See § 7 |
| `Compiler` source write / obj read, `Scorer` object reads | `Bun.write` / `Bun.file(p).arrayBuffer()` | Faster I/O paths than `fs.promises` |
| `Deduplicator.hash` | `Bun.hash(source).toString(36)` | Wyhash is ~10× faster than `crypto.createHash('sha256')` and dedup doesn't need a cryptographic hash |
| `createControlServer` | `Bun.serve` | Native HTTP server; replaces `@hono/node-server` which had a hard Node dependency |
| `ctl` HTTP client | `fetch()` | Native; replaces `http.request` |
| objdiff-wasm loader | Bun's native `fetch` resolves `file://` URLs | The old `globalThis.fetch` monkey-patch is unnecessary and has been removed |

Test runner: `bun --bun vitest run`. The `--bun` flag forces vitest's Node shebang to be ignored — plain `bun run vitest` would still launch a Node process and the `Bun.*` APIs would be undefined. Tests live alongside code (`*.spec.ts`) and run against real compilers.

### Build Configuration

- **TypeScript:** strict mode, `strictNullChecks: true`, `noUncheckedIndexedAccess: true`. `types: ["node", "bun"]` in `tsconfig.base.json` (`@types/bun` ships `Bun.*` and related globals).
- **Module system:** ESM (`"type": "module"`)
- **Build:** both `@transmuter/core` and `@transmuter/cli` bundle with `bun build` (see each package's `build.ts`). Core also runs `tsc --emitDeclarationOnly` for published types; `build:esm` skips that step for fast dev rebuilds. CLI has a `predev` hook that auto-rebuilds core before running.
- **Dev scripts:** `bun run <entry>.ts` — Bun runs TypeScript natively, no `tsx`/`ts-node`
- **Path aliases:** `~` -> `./src` within core package
- **Workspace:** pnpm workspaces with `workspace:*` protocol (pnpm stays as the package manager on top of Bun's runtime)

### Dependencies

**@transmuter/core:**
- `@ast-grep/napi` — AST parsing and pattern matching (NAPI; Bun loads prebuild `.node` binaries the same way Node does)
- `tree-sitter-c` — C grammar (prebuild `.node` loaded via `createRequire` + `require.resolve`)
- `@ast-grep/lang-cpp` — C++ grammar (official ast-grep package with platform-specific binaries)
- `tree-sitter-pascal` — Pascal/Delphi/FreePascal grammar (Isopod/tree-sitter-pascal; built locally via node-gyp)
- `objdiff-wasm` — assembly diffing and scoring
- `diff` — unified diff generation for reports

**@transmuter/cli:**
- `@transmuter/core`
- `hono` — HTTP routing (mounted via `Bun.serve`, no Node adapter)
- `ink` + `react` — terminal UI rendering
- `ink-spinner` — spinner component
- `yaml` — decomp.yaml parsing

**@transmuter/webapp:**
- `@xyflow/react` — candidate graph visualization
- `@dagrejs/dagre` — graph layout algorithm
- `echarts` — score timeline charts
- `@wooorm/starry-night` — syntax highlighting (C, C++, Pascal, asm, diff)

---

## 2. Core Pipeline

### Flow

```
                    ┌─────────────────────────────────────┐
                    │          SlotOrchestrator            │
                    │  (manages N concurrent slots)        │
                    └─────┬──────────┬──────────┬─────────┘
                          │          │          │
                     ┌────▼───┐ ┌───▼────┐ ┌───▼────┐
                     │ Slot 0 │ │ Slot 1 │ │ Slot N │   (concurrent async loops)
                     └────┬───┘ └───┬────┘ └───┬────┘
                          │         │          │
            ┌─────────────▼─────────▼──────────▼──────────────┐
            │                   Per-Slot Loop                   │
            │                                                   │
            │  1. pool.select()              ← Pick target      │
            │  2. get head candidate source                     │
            │  3. engine.mutate(source, breakdown) ← Apply rule (filtered by diff-type affinity) │
            │  4. dedup.check(hash)          ← Skip if seen     │
            │  5. candidateFilter?()         ← Optional gate    │
            │     ↳ maxUnproductiveIterations check (stop if 0 compiles after N iterations)
            │  6. compiler.compile()         ← Subprocess       │
            │  7. scorer.scoreWithAssembly() ← objdiff-wasm     │
            │  8. pool.report()              ← Fork if improved │
            │  9. adaptive feedback           ← Record outcome for Thompson Sampling │
            │ 10. emit events                 ← Notify consumers │
            └──────────────────────────────────────────────────┘
```

Step 7 uses `scoreWithAssembly()` which returns an `AssemblyScoreResult` containing score, `DiffBreakdown` with per-instruction-type counts, assembly text, and assembly diff in a single objdiff pass. When a fork occurs (step 8), the assembly data and breakdown are stored directly on the new `CandidateNode` — no recompilation needed at report time.

The `Compiler` class writes source to temp files with language-appropriate extensions (`.c`, `.cpp`, `.pas`) so that compiler drivers like IDO's `cc`/`NCC` can select the correct frontend based on the file extension.

#### Compiler stdio: fd-to-tempfile, not pipes (load-bearing)

`Compiler.#exec` routes child stdout and stderr through **file descriptors opened on temp files**, not through the subprocess's built-in pipes. This is not cosmetic — it's a workaround for an OS-level stall:

- Wine's stderr, when connected to a pipe from Bun/Node, stalls for ~5 s per compile on macOS (specifically `mwcceppc` + Wine Crossover; likely a pipe-buffering / small-write pattern interaction). The same compile with stderr redirected to a file completes in ~0.6 s.
- Switching `Bun.spawn` to `stdio: ['ignore', 'pipe', 'pipe']` reproduces the stall (throughput drops from ~6.9 compiles/s to ~1.2 compiles/s at 8-parallel) — confirming it's a pipe-vs-fd problem at the OS/Wine layer, not a Node-vs-Bun one.
- The fd approach: `openSync(path, 'w')` → pass fd in `stdio[1/2]` → `closeSync` after exit → read the file back (capped at 50 KB via `readTruncated` which uses `Bun.file(p).slice(0, 50_000).arrayBuffer()`).

`#exec` also sets `detached: true` on `Bun.spawn`, which puts the shell in its own process group. On abort, `process.kill(-proc.pid, 'SIGTERM')` signals the entire group so that grandchildren spawned from `sh -c '... && ...'` (e.g., `cpp | cc | as` pipelines) die with the shell.

### Candidate Graph Model

The pool manages a **candidate graph** — a tree of `CandidateNode`s connected by `parentId` pointers:

- The **genesis** is the root (the initial input code). It is never mutated in place.
- When a mutation produces a better score, the Pool **forks**: creates a new `CandidateNode` and a new `MutationTarget` for it. The parent's target is unchanged — it keeps exploring from the same source.
- This means the genesis is always being mutated (can always discover new paths), and each fork opens a new exploration frontier. The graph grows both wide (parent finds multiple improvements) and deep (forks find their own improvements).

**Lateral forks:** When `lateralForkBudget > 0`, the pool also forks on same-score mutations (lateral moves). This allows exploring code plateaus where intermediate transformations don't improve the score but are stepping stones to a better solution. Each target has its own lateral fork budget. The refiner sets a budget of 10 to enable multi-step rewrites (e.g., removing a signed-division idiom requires deleting the if-block, converting shift to division, and folding into a compound return — none of these improves the score individually, but the combination reaches score 0). The permuter uses 0 (strict improvement only).

**Fork deduplication:** Not every improvement triggers a fork. Forks are deduplicated per-target by the tuple `(scoreDelta, ruleId, line, column)`:
- Improvement of 3, rule X at L5:C1 -> fork (first occurrence)
- Improvement of 3, rule X at L5:C1 -> no fork (duplicate)
- Improvement of 2, rule X at L5:C1 -> fork (different delta)

**Pruning and compaction:** Consumers can `disableBranch(targetId)` to remove a target from scheduling, or prune in bulk via the API. When branches are pruned, **graph summarization** runs automatically: dead-end subtrees (candidates with no active target in their lineage) are replaced by lightweight `SuperNode` summaries and their `CandidateNode` objects, `MutationTarget` entries, fork-dedup sets, and Thompson Sampling statistics are freed from memory. The algorithm handles multi-root forests (external injections via `pool.inject()` create additional roots with `parentId: undefined`). Disabled targets that still have active descendants are preserved; only fully dead subtrees are summarized.

**Auto-compact:** Enabled by default on all modes (match, refine, cleanup). Every `statsInterval` iterations (default: 100), `MutationSearch` evaluates the pool using two strategies (whichever fires first):

1. **Population-based** (Strategy 1, priority): When `activeTargets > keepN * 3` (where `keepN = max(keepMinTargets, concurrency * 5)`, default: 20 at concurrency 4), sort all targets by score and keep only the best N. This creates entire dead subtrees that `summarize()` can free. Works even in high-fork-rate sessions (e.g., refine with ~47% fork rate) where individual staleness tracking cannot trigger.

2. **Staleness-based** (Strategy 2): For smaller pools, disable individual targets whose `attemptsWithoutFork >= effectiveThreshold`, where `effectiveThreshold = max(minStaleThreshold, staleAfterAttempts / sqrt(activeTargets / concurrency))`. With defaults (`staleAfterAttempts: 500`, `minStaleThreshold: 20`), a pool of 500 targets with concurrency 4 has an effective threshold of ~45.

Both strategies are **self-stabilizing**: pruning shrinks the pool, which raises the threshold, which stops pruning. The check only fires when `candidateCount >= candidateThreshold` (default: 200). After disabling targets, graph summarization runs automatically to free memory. Pass `autoCompact: false` to `MutationSearchOptions` to disable.

**Weighted selection:** Targets are selected via weighted-random proportional to their `weight` (default: 1 for all). Consumers can adjust weights at runtime via `setBranchWeight()`.

### Concurrency Model

`SlotOrchestrator` spawns N Bun Workers (threads), each running the **full mutate → dedup → compile → score pipeline** in its own JS VM. Main thread owns the `Pool`, the authoritative `AdaptiveSelector`, event emission, and the HTTP API; workers receive jobs from main and reply with one of `no-mutation` / `dedup` / `compile-error` / `scored`. Worker count comes from `opts.concurrency` (default: `min(os.cpus().length, 4)`).

Each worker owns its own `Compiler`, `Scorer`, `Deduplicator`, `MutationEngine`, and forked `Rng` (derived deterministically from base seed and slot id). `AdaptiveSelector` snapshots are rebroadcast from main every N iterations (default 100) to all workers — including `concurrency === 1` — because workers do not record locally; without the rebroadcast their selectors would stay at the initial snapshot and rule selection would become non-adaptive. Dedup set is per-worker (cross-worker duplicates cost one wasted compile per collision but don't require a shared set).

**Determinism.** With `concurrency: 1`, a fixed `seed`, and a fixed `maxCompiles`, runs are bit-identical across invocations. Above N=1, worker-result ordering depends on real-time scheduling, so `--seed` gives reproducible per-worker RNG sequences but not bit-identical end-state; use `--concurrency 1` for reproducibility tests.

**Performance.** Measured improvements vs the previous single-thread async orchestrator:

| Workload | 4-way improvement | 8-way improvement |
|---|---|---|
| agbcc native (`entity-item-drop`) | parity | **2.4× succ iter/s, 2.6× c-att/s** |
| Wine/mwcc (Melee `fn_8030110C`) | **+58 % c-att/s** | **+3 % c-att/s** |

The 8-way win on agbcc-native comes from removing main-event-loop stall on `await proc.exited`. With a single event loop servicing 8 concurrent compile awaits + mutate/score/report/Ink-render bookkeeping, microtask wake-ups queue behind that work and inflate per-compile wall from the isolated-spawn baseline of ~87 ms to ~474 ms. Workers give each slot its own loop; per-compile wall returns to the baseline.

Runtime control hooks (`updateWeights`, `enableRule`, `disableRule`, `setFocusConstraints`, `setMutationDepth`) fan out to all workers via control messages — `SlotOrchestrator.broadcastRules()` / `setFocusConstraints()` / `setMutationDepth()` respectively. Pool mutations remain on main only.

Worker entry: `packages/core/src/search/slot-worker.ts`, shipped as a separate bundle entry (see `packages/core/build.ts`) and resolved at runtime via the `@transmuter/core/slot-worker` package export.

---

## 3. Language Detection

Transmuter auto-detects the source language from the file extension. No `--language` flag is needed.

```typescript
type Language = 'c' | 'cpp' | 'pascal';
```

### Extension Map

| Extension | Language |
|-----------|----------|
| `.c`, `.h` | `c` |
| `.cpp`, `.cc`, `.cxx`, `.hpp` | `cpp` |
| `.pas`, `.pp` | `pascal` |

The `detectLanguage(filePath)` function resolves a file path to a `Language`. It throws if the extension is unrecognized.

### Grammar Registration

Each language has a tree-sitter grammar registered on first use in `parser.ts`:

| Language | Package | Registration |
|----------|---------|-------------|
| C | `tree-sitter-c` | `registerDynamicLanguage()` — loads native `.node` binding from `prebuilds/` |
| C++ | `@ast-grep/lang-cpp` | `registerDynamicLanguage()` — official ast-grep package with platform binaries |
| Pascal | `tree-sitter-pascal` | `registerDynamicLanguage()` — loads from `build/Release/` (node-gyp build) |

All three languages register synchronously via `ensureLanguageRegistered(language)`. `parse()` calls it internally, so explicit registration is only needed if you're warming up the grammar before parse time.

### Pascal AST

tree-sitter-pascal (Isopod/tree-sitter-pascal) targets Delphi/FreePascal. Key node kinds differ from C:

| Concept | C/C++ node kind | Pascal node kind |
|---------|-----------------|-----------------|
| Function definition | `function_definition` | `defProc` |
| Function header | `function_declarator` | `declProc` |
| Block body | `compound_statement` | `block` |
| Binary expression | `binary_expression` | `exprBinary` |
| Function call | `call_expression` | `exprCall` |
| Call arguments | `argument_list` | `exprArgs` |
| Variable section | — | `declVars` |
| Variable declaration | `declaration` | `declVar` |
| Assignment | `assignment_expression` | `assignment` |

Pascal-specific helpers in `pascal-helpers.ts` provide `findPascalFunction`, `findPascalFunctionBody`, `getPascalStatements`, and `getPascalVarDeclarations` using these node kinds. Function name matching is **case-insensitive** because IDO Pascal lowercases all symbol names.

---

## 4. Multi-Language Architecture

Language support is **transparent** — the pipeline, pool, scoring, and session store are all language-agnostic. Language awareness is confined to three boundaries:

1. **Parser** (`parser.ts`) — routes `parse(language, source)` to the correct tree-sitter grammar
2. **Rules** — each rule declares `languages: readonly Language[]` and is only selected when the session language matches
3. **Guidelines** — each guideline declares `languages: readonly Language[]` and is only listed/used for matching languages

Everything else (compilation, scoring, events, reports, webapp) works identically regardless of language. The `MutationEngine` filters rules by language via `registry.getActiveRules(language)`, so language-incompatible rules are never attempted.

### How Language Flows Through the System

```
CLI detects language from file extension
  → MutationSearch constructor receives language option (default: 'c')
    → ensureLanguageRegistered(language)
    → MutationEngine stores language, passes to parse() and rule context
    → RuleRegistry.getActiveRules(language) filters rules
    → SessionConfig.language stored in report
    → Webapp reads config.language for CodeBlock syntax highlighting
```

---

## 5. Mutation Rule System

### Rule Interface

```typescript
interface Rule {
  readonly id: string;
  readonly description: string;
  readonly languages: readonly Language[];  // e.g., ['c', 'cpp'] or ['pascal']
  readonly defaultWeight: number;
  readonly relevantDiffTypes?: ReadonlySet<DiffType>;  // diff-type affinity filter
  apply(ctx: MutationContext): MutationApplyResult | null;
}

interface MutationApplyResult {
  source: string;
  location: { line: number; column: number };  // 1-indexed AST node position
}

interface MutationContext {
  source: string;
  root: SgRoot;
  rng: Rng;
  functionName: string;
  language: Language;
  nodeFilter?: NodeFilter;  // biases toward focus regions
}
```

Rules return the mutated source **and** the location of the AST node they targeted. The location is used for fork deduplication. The `language` field in `MutationContext` lets rules branch on language when needed, though most language-specific rules are separate implementations.

### Mutation Engine

Selects rules via a two-layer filtering and selection process:

1. **Diff-type affinity filter**: Rules that declare `relevantDiffTypes` are excluded when none of their declared types remain in the target candidate's `DiffBreakdown`. Rules without `relevantDiffTypes` are always eligible.
2. **Adaptive selection**: Per-target Thompson Sampling selects from eligible rules, learning which rules are effective for each mutation target.

Rules are also **filtered by the session language**. If a selected rule returns null, tries another (up to `MAX_ATTEMPTS = 10`). When `depth > 1`, chains multiple mutations. The location from the last applied rule is returned.

### AST-Traversal Caching (`rules/helpers.ts`)

Within one `#applyOne` call up to 10 rules are tried against the same source, each typically calling `findTargetFunction(root, fnName)` and `fn.findAll({ rule: { kind: 'X' } })`. Naively, this re-walks the AST across the NAPI bridge up to 10× per iteration. Two WeakMap-backed caches eliminate the redundancy:

- **`findTargetFunction`** memoises via `WeakMap<SgRoot, Map<string, SgNode|null>>` keyed on `(language, functionName)`. Since `parseCached` in `parser.ts` hands out the same `SgRoot` instance across iterations that share a source, the cache also hits across iterations — a slot that runs 30 attempts against the same head candidate pays for the function lookup exactly once.
- **`findAllByKind(node, kind)`** memoises via `WeakMap<SgNode, Map<string, SgNode[]>>`. Called on the (cached) target function node, so rule-to-rule cache hits are guaranteed when rules ask for the same AST kind. Rules with simple kind-only queries use this helper; rules with compound matchers (`has:`, `regex:`, nested queries) still use `node.findAll(...)` directly.

Impact: at the reference c=8 benchmark, mutate-phase CPU drops from ~55 s → ~4 s per 8-slot × 90 s window (~14× reduction; `ruleApply` alone drops ~17×). The saving is invisible in top-line iter/s on the Wine/mwcc workload because compile is already the ceiling (moves from 90 % → 99 % of CPU budget), but it unlocks headroom for higher concurrency, richer mutations, and future worker-based parallelism.

### Built-In Rules (49 total)

Ported from decomp-permuter's passes, plus new asm-specific rules, C++ rules, and Pascal rules:

| Category | Rules | Languages |
|----------|-------|-----------|
| Statement reordering | `reorder-stmts`, `reorder-decls`, `sameline`, `delete-stmt` | C, C++ |
| Type/cast | `cast-expr`, `remove-cast`, `void-cast`, `randomize-type` | C, C++ |
| Assignment patterns | `chain-assignment`, `split-assignment`, `duplicate-assignment`, `self-assignment`, `long-chain-assignment`, `compound-return` | C, C++ |
| Arithmetic/bitwise | `commutative-swap`, `add-sub-swap`, `mult-zero`, `xor-zero`, `factor-mult`, `factor-shift`, `shift-div-swap` | C, C++ |
| Expressions | `temp-for-expr`, `expand-expr`, `refer-to-var`, `comma-expr`, `extra-parens`, `float-literal` | C, C++ |
| Control flow | `insert-block`, `modify-condition` | C, C++ |
| Inline assembly | `asm-barrier`, `asm-register-swap` | C |
| Other (C/C++) | `add-mask`, `struct-ref-swap`, `pad-var-decl`, `empty-stmt`, `inequality-swap` | C, C++ |
| C++ specific | `explicit-this`, `cast-style-swap`, `reorder-field-init` | C++ |
| Pascal statements | `pascal-reorder-stmts`, `pascal-reorder-vars` | Pascal |
| Pascal expressions | `pascal-commutative-swap`, `pascal-extra-parens`, `pascal-bool-negate`, `pascal-arith-shift` | Pascal |
| Pascal control flow | `pascal-loop-swap`, `pascal-begin-wrap` | Pascal |
| Pascal type/cast | `pascal-type-cast`, `pascal-intrinsic-swap` | Pascal |

Profiles override default weights. For example, `ido` disables `asm-barrier` (IDO doesn't understand GCC asm syntax).

### Diff Type Affinity

Each rule can declare which assembly diff types it's designed to address:

| Affinity | Rules | Rationale |
|----------|-------|-----------|
| `argMismatch` | reorder-stmts, reorder-decls, commutative-swap, asm-barrier, asm-register-swap, pad-var-decl, self-assignment, sameline | Affect register allocation |
| `opMismatch` | shift-div-swap, add-sub-swap, inequality-swap, factor-shift, factor-mult | Change instruction opcodes |
| `opMismatch, argMismatch` | cast-expr, remove-cast, cast-style-swap, struct-ref-swap, modify-condition, compound-return | Affect both |
| `insert, delete` | empty-stmt, void-cast | Change instruction count |
| `insert, delete, argMismatch` | temp-for-expr, expand-expr, split-assignment, chain-assignment, long-chain-assignment, duplicate-assignment | Change instruction count and register usage |
| `opMismatch, insert, delete` | insert-block, delete-stmt | Change control flow |
| *(always eligible)* | randomize-type, float-literal, refer-to-var, comma-expr, extra-parens, mult-zero, xor-zero, add-mask, explicit-this, reorder-field-init | Unpredictable effects |

Pascal rules follow the same pattern (e.g., pascal-reorder-stmts -> argMismatch).

### Adaptive Rule Selection

Per-target Thompson Sampling is always active. It learns which rules are effective for each mutation target:

- Each mutation target maintains independent Beta(alpha, beta) distributions per rule
- On each selection: sample from Beta distributions of eligible rules, pick highest
- Binary reward: forked (improved) = success, no fork = failure
- Sliding window (default 500 trials) ensures stale data ages out
- New targets inherit parent stats on fork, then diverge independently

---

## 6. State Management

### CandidateNode

```typescript
interface CandidateNode {
  id: string;
  source: string;
  score: number;
  iteration: number;
  timestamp: number;
  mutationTargetId: string;
  parentId?: string;
  origin: 'genesis' | 'organic' | 'external';
  ruleId?: string;
  location?: { line: number; column: number };
  externalLabel?: string;
  assembly: string;       // compiled assembly text
  assemblyDiff: string;   // objdiff differences against target
  breakdown: DiffBreakdown;  // per-type diff decomposition
}
```

Every candidate stores its compiled assembly and the objdiff comparison against the target. These are captured at creation time during the same objdiff pass that computes the score — no recompilation needed.

### MutationTarget

```typescript
interface MutationTarget {
  id: string;
  candidateId: string;   // the candidate being mutated (never changes)
  weight: number;         // scheduling weight (default: 1)
  enabled: boolean;       // if false, skipped during scheduling
  attempts: number;       // mutations attempted
  createdAt: number;
  lastImprovedAtIteration: number | null;  // iteration of last fork, null if never
}
```

### Pool

```typescript
class Pool {
  init(source, score, iteration?, assemblyData?): { candidate, target };
  select(): MutationTarget;                    // weighted-random from enabled targets
  report(report, iteration): { forked? };      // fork-on-improvement with dedup
  inject(source, score, options?): { candidate, target };  // external injection
  disable(targetId): void;
  enable(targetId): void;
  setWeight(targetId, weight): void;
  getBest(): CandidateNode;
  getLineage(candidateId): CandidateNode[];
  getChildren(candidateId): CandidateNode[];
  summarize(): SummarizeResult;                // graph summarization: replaces dead subtrees with supernodes
  getSuperNodes(): SuperNode[];                // accumulated supernodes from past summarize() calls
}
```

### SuperNode

```typescript
interface SuperNode {
  id: string;                    // "supernode-{parentCandidateId}" or "supernode-root-{rootId}"
  parentId?: string;             // undefined for summarized root trees (dead injections)
  summarizedCount: number;       // number of candidates removed
  bestScore: number;
  worstScore: number;
  rules: string[];               // distinct rule IDs from the summarized candidates
  bestSource: string;            // source of the best-scoring candidate in the group
}
```

---

## 7. Bidirectional Communication API

### Events (Library -> Consumer)

```typescript
type MutationSearchEvent =
  | { type: 'started'; baseScore; targetCount; ruleDescriptions }
  | { type: 'scored'; iteration; score; ruleId; mutationTargetId }
  | { type: 'forked'; iteration; parentCandidateId; candidateId; mutationTargetId;
      oldScore; newScore; source; ruleId; location; assembly; assemblyDiff; breakdown }
  | { type: 'perfect-match'; iteration; source; candidateId }
  | { type: 'compilation-error'; mutationTargetId; ruleId; error }
  | { type: 'stats'; iteration; elapsed; targets; bestScore; candidateCount;
      compiled; errors; deduped; rulesUsed }
  | { type: 'completed'; reason: 'perfect-match' | 'max-iterations' | 'timeout' | 'aborted' | 'exhausted';
      finalScore; totalIterations; elapsed; bestSource }
  | { type: 'error'; message }
  | { type: 'mutation-target-created'; mutationTargetId; candidateId; score; origin;
      source?; assembly?; assemblyDiff? }
  | { type: 'mutation-target-disabled'; mutationTargetId }
  | { type: 'mutation-target-enabled'; mutationTargetId }
  | { type: 'mutation-target-weight-changed'; mutationTargetId; weight }
  | { type: 'graph-summarized'; removedCount; superNodeCount }
  | { type: 'auto-compacted'; disabled; removed; superNodes }
  | { type: 'focus-mutation'; constraintId; ruleId; improved }
  | { type: 'focus-rejected'; constraintId; ruleId; reason }
  | { type: 'hypothesis-scored'; constraintId; score; mutationTargetId? }
```

The `forked` event carries `assembly` and `assemblyDiff` so the `SessionStore` can reconstruct candidates with full assembly data from the event stream alone. The `mutation-target-created` event carries `source` for external (injected) candidates so the `SessionStore` stores the actual injected source rather than the genesis source.

### Controls (Consumer -> Library)

```typescript
class MutationSearch {
  start(): Promise<MutationSearchResult>;
  stop(): void;
  pause(): void;
  resume(): void;
  injectCode(source, options?): Promise<{ candidate, target } | null>;
  getAssemblyDiff(source): Promise<{ assembly, targetAssembly, diff, differences, structuredDifferences, differenceCount, matchingCount } | null>;
  setBranchWeight(mutationTargetId, weight): boolean;
  disableBranch(mutationTargetId): boolean;
  enableBranch(mutationTargetId): boolean;
  updateWeights(weights): string[];        // returns unknown rule IDs
  enableRule(ruleId): boolean;
  disableRule(ruleId): boolean;
  setFocusConstraints(focusRegions, avoidRegions): void;
  getFocusConstraints(): { focusRegions; avoidRegions };
  setMutationDepth(depth): void;
  getMutationDepth(): number;
  getState(): MutationSearchState;         // includes functionName
  getRules(): { ruleId, description, weight, enabled }[];  // rule catalog with current state
  getBranchRuleHistory(branchId): { ruleId, trials, successRate }[] | null;  // per-branch adaptive stats (sliding window)
  summarize(): SummarizeResult;       // graph summarization: frees dead candidates + adaptive state
}
```

### Focus Constraints

```typescript
type FocusConstraint =
  | FocusRegionConstraint    // bias mutations toward specific lines
  | AvoidRegionConstraint    // reject mutations touching protected lines
  | HypothesisConstraint;   // compile/score/inject external code as a target
```

---

## 8. Refinement (`transmuter refine`)

Improves code quality of already-matching code by removing violations while preserving the assembly match.

### Two-Phase Algorithm

**Phase 1 — Parallel exploration:** For each violation, independently attempt to fix it by removing the violation and running a sub-MutationSearch to re-match. Violations are fixed in parallel (concurrency split across them). Each sub-session uses `maxUnproductiveIterations: 100,000` — if no mutation passes the candidateFilter and reaches the compiler within 100K iterations, the sub-session stops with reason `'exhausted'` and the violation transitions to `'transmuter-exhausted'`. This prevents indefinite spinning when random mutations cannot produce the required code structure (e.g., removing asm register pins).

**Trivial fixes:** If simply removing the violation text (via `guideline.remove()`) produces a score of 0, the violation is trivially fixed — no MutationSearch is needed. The `fixedSource` and `fixDiff` are recorded immediately on the `violation-trivially-fixed` event.

**Phase 2 — Sequential merge:** Combine individual fixes into a single source. Apply easiest fixes first. After each fix, re-detect remaining violations (prior fixes may have incidentally resolved others).

**Injection-based fixes:** When an LLM agent injects code via `POST /inject` during refine mode, the `Refiner.injectCode()` method checks whether the injection constitutes a fix: if the injected code scores 0 (perfect assembly match) and the specific violation is no longer detected via `guideline.detect()`, the violation transitions to `'fixed'` and the sub-session stops. This uses per-violation detection rather than the `candidateFilter` (which may be too broad — e.g., `containsViolation` checks for any asm pin, not just the specific one).

### Guideline System

```typescript
interface Guideline {
  readonly id: string;
  readonly description: string;
  readonly languages: readonly Language[];  // e.g., ['c', 'cpp'] or ['pascal']
  readonly disabledRules: string[];
  detect(source, functionName): Violation[];
  remove(source, violation): string | null;
  containsViolation?(source, violation): boolean;  // AST-based for no-asm-pin
}
```

Built-in guidelines (4 total):

| Guideline | Languages | Description |
|-----------|-----------|-------------|
| `no-asm-pin` | C | Removes asm barriers and register pins |
| `no-goto` | C, C++ | Removes goto statements |
| `no-c-style-cast` | C++ | Replaces C-style casts with `static_cast` |
| `no-redundant-cast-pascal` | Pascal | Removes redundant function-style type casts |

The `GuidelineRegistry.list(language)` method filters guidelines by language, so `transmuter refine` only shows guidelines applicable to the source language.

### LLM Guidance

The `--constraints <path>` flag accepts a JSON file with:
- `focusConstraints` — passed through to each violation's sub-MutationSearch
- `violationHypotheses` — per-violation hypothesis code injected as branches

Each violation's sub-session report (including candidate graph, rule stats, focus results, assembly diff) is included in the refinement report for LLM analysis.

---

## 9. Cleanup (`--cleanup`)

Post-match source simplification. Activated by the `--cleanup` flag on both `transmuter match` and `transmuter refine`. Runs after a perfect match (score 0) is found, producing cleaner code while guaranteeing the assembly stays identical.

### Why

Transmuter's mutations often find matching code through non-obvious paths — inserting temp variables, wrapping in `do-while(0)`, adding redundant casts. These artifacts match the target assembly but produce ugly, hard-to-maintain code. Cleanup removes them.

### Language Support

Phase 1 canonicalization passes use C/C++ tree-sitter node kinds (`compound_statement`, `do_statement`, `declaration`, `init_declarator`, `cast_expression`). They silently produce no candidates for Pascal, where the AST uses different node kinds. Phase 2 works for all languages since it delegates to `MutationEngine`, which filters rules by language.

### Two-Phase Pipeline

```
Phase 1: Canonicalization (fast, deterministic) — C/C++ only
  → do-while(0) unwrap
  → Dead variable elimination
  → Single-use variable inlining
  → Redundant cast removal
  → Whitespace normalization (collapse consecutive blank lines)

Phase 2: Smell-budget permutation (slower, creative) — all languages
  → Mutation loop with assembly preservation constraint
  → Optimizes for lowest smell score
  → Enables constructive rewrites (>> to /, compound returns)
```

**Phase 1 — Canonicalization** (`cleanup/canonicalizer.ts`):

Five deterministic AST-level passes run in a loop until fixpoint (no pass makes progress). Each candidate transformation is compiled and scored — only kept if the assembly output remains identical (score 0).

| Pass | What it does |
|------|-------------|
| `do-while-zero-unwrap` | Replace `do { body } while(0);` with just `body` |
| `dead-variable-elimination` | Remove variables assigned but never read |
| `single-use-inline` | Inline `type x = expr; ... use(x)` → `... use(expr)` and remove the declaration |
| `redundant-cast-removal` | Remove `(type)expr` casts (kept only if assembly-safe) |
| `normalize-whitespace` | Collapse consecutive blank lines, fix formatting |

**Phase 2 — Smell-budget permutation** (`cleanup/cleanup.ts`):

Delegates to `MutationSearch` with a `scoreTransform` hook that replaces the assembly diff score with the smell score. The `scoreTransform` receives the full `AssemblyScoreResult` (including `DiffBreakdown`), not just an integer:

- Assembly doesn't match (asmScore != 0) -> returns a penalty score (999999 + asmScore), ensuring the Pool never forks on assembly-breaking mutations
- Assembly matches (asmScore == 0) -> returns the smell score, so the Pool optimizes for lower smell

This gives Phase 2 the same concurrency, multi-branch exploration, and lateral fork budget as the main match engine. Simplifying rules are boosted (`delete-stmt: 50`, `remove-cast: 40`, `expand-expr: 40`, `shift-div-swap: 30`, `compound-return: 30`), additive rules are disabled, and `lateralForkBudget: 5` allows exploring through smell plateaus.

Phase 2 only runs if Phase 1 leaves remaining smells. It handles constructive transformations that Phase 1 can't (e.g., converting `>> 8` to `/ 256`).

### Smell Scoring (`cleanup/smell.ts`)

AST-based, deterministic. Counts five metrics with different weights:

| Metric | Weight | Description |
|--------|--------|-------------|
| Temp variables | 10 | Declarations matching `_tNNN` pattern |
| `do-while(0)` | 10 | `do { ... } while(0)` wrappers |
| Single-use variables | 5 | Variables assigned once, read once (inlining candidates) |
| Type casts | 3 | `(type)expr` cast expressions |
| Statement count | 1 | Total statements across all blocks (complexity proxy) |

`total = tempVars*10 + doWhile0*10 + singleUse*5 + casts*3 + stmtCount*1`

### Events

```typescript
type CleanupEvent =
  | { type: 'phase1-started' }
  | { type: 'phase1-progress'; pass: string; applied: number }
  | { type: 'phase1-completed'; result; smellBefore; smellAfter }
  | { type: 'phase2-started'; smellScore: number }
  | { type: 'phase2-progress'; iteration: number; bestSmell: number }
  | { type: 'phase2-completed'; result: SmellPermutationResult }
  | { type: 'completed'; result: CleanupResult };
```

### Limitations

- **Phase 1 is C/C++ only.** Canonicalization passes use C tree-sitter node kinds. Pascal is silently skipped (Phase 2 still runs).
- **Temp variable smell only detects `_tNNN` names.** This is Transmuter's own `temp-for-expr` naming pattern. Decompiler-generated temps (m2c's `temp_f0`, Ghidra's `local_30`, Hex-Rays' `v1`) are not counted.
- **Smell scoring is a proxy, not a semantic measure.** The weighted sum (temp vars, casts, do-while(0), statement count) is a reasonable heuristic but doesn't capture all readability dimensions (e.g., meaningful variable names, control flow complexity).

### Library Usage

```typescript
import { Cleanup } from '@transmuter/core';

const cleanup = new Cleanup({
  source: matchingSource,  // must already score 0
  functionName: 'FixedMul8',
  targetObjectPath: './target.o',
  compilerCommand: 'agbcc -O2 -mthumb {{inputPath}} -o {{outputPath}}',
  cwd: '/path/to/project',
  maxIterations: 50_000,   // Phase 2 budget
  timeoutMs: 60_000,       // Phase 2 timeout
  onEvent(event) {
    if (event.type === 'completed') {
      console.log(`Smell: ${event.result.smellBefore.total} → ${event.result.smellAfter.total}`);
    }
  },
});

const result = await cleanup.run();
console.log(result.source);  // Cleaned-up code, still compiles to identical assembly
```

---

## 10. Session Report (v1)

```typescript
interface SessionReport {
  version: 1;
  type: 'match';
  metadata: SessionMetadata;
  config: SessionConfig;
  summary: SessionSummary;
  graph: {
    candidates: CandidateNode[];   // each with assembly + assemblyDiff
    mutationTargets: MutationTargetInfo[];
    superNodes?: SuperNode[];      // summaries of pruned dead-end subtrees
  };
  ruleStats: RuleStatsEntry[];
  scoreTimeline: TimelinePoint[];
  focusResults: FocusResult[];
}

interface SessionConfig {
  functionName: string;
  targetObjectPath: string;
  compilerCommand: string;
  language: Language;          // source language for this session
  profile?: string;
  concurrency: number;
  maxIterations: number;
  timeoutMs: number;
  seed: number;
  mutationDepth: number;
  ruleWeights: Record<string, number>;
  disabledRules: string[];
  focusConstraints: FocusConstraint[];
}
```

The `graph.candidates` array contains every `CandidateNode` with its `assembly` and `assemblyDiff` fields already populated. The webapp can render assembly tabs directly from the report without any server-side compilation. When graph summarization has been applied, `graph.superNodes` contains lightweight summaries of pruned dead-end subtrees — each preserving the candidate count, score range, rules used, and the best candidate's source code.

### Refinement Report

```typescript
interface RefinementReport {
  version: 1;
  type: 'refinement';
  metadata: SessionMetadata;
  config: RefinementConfig;
  guideline: { id; description };
  violations: ViolationReport[];  // each with optional subSession (SessionReport)
  mergeLog: MergeLogEntry[];
  finalResult: RefinementResult;
  focusResults?: Record<string, FocusResult[]>;
  ruleStats: RuleStatsEntry[];
}

interface RefinementConfig {
  functionName: string;
  targetObjectPath: string;
  compilerCommand: string;
  language: Language;          // source language for this session
  profile?: string;
  guidelineId: string;
  concurrency: number;
  maxIterationsPerViolation: number;
  timeoutMsPerViolation: number;
  seed: number;
}
```

---

## 11. Webapp

The webapp (`@transmuter/webapp`) renders both match and refinement reports. Source code blocks are syntax-highlighted for C, C++, Pascal, assembly, and diff via `@wooorm/starry-night`.

### Match View

| Tab | Content |
|-----|---------|
| Overview | Session summary + score timeline chart |
| Graph | Interactive candidate graph (@xyflow/react). Nodes = candidates (+ supernodes for pruned branches), edges = forks. Click for detail panel. Supernodes show pruned candidate count, score range, and best source |
| Rules | Rule effectiveness table (applied, forked, success rate, avg delta) |
| Focus | Focus constraint results (if constraints were used) |

**Candidate Detail Panel** — when a candidate node is clicked in the Graph tab, a right-side panel shows:

| Detail Tab | Content |
|------------|---------|
| Source | Raw source code (syntax-highlighted for the session language) |
| Source Diff | Unified diff against a selected candidate (defaults to genesis), computed via LCS |
| Assembly | Compiled assembly text (from `CandidateNode.assembly`) |
| Assembly Diff | Objdiff differences against the target (from `CandidateNode.assemblyDiff`) with diff highlighting |

### Refinement View

| Tab | Content |
|-----|---------|
| Overview | Violations fixed progress, guideline info, config |
| Violations | Per-violation cards with status, exploration stats, assembly diff. Drill-down into sub-session graph |
| Rules | Aggregated rule stats across all sub-sessions |
| Merge Log | Step-by-step merge timeline (hidden for single violations) |
| Result | Final refined source viewer |

---

## 12. CLI Commands

### `transmuter match`

Main match command with live Ink dashboard showing score, mutation targets, forks, and sparkline. With `--cleanup`, runs the cleanup pipeline after finding a perfect match.

### `transmuter refine`

Code quality refinement. Lists guidelines when `--guideline` is omitted. Shows per-violation progress, hypothesis scores, and merge steps. With `--cleanup`, runs the cleanup pipeline after successful refinement.

### `transmuter reduce`

Minimizes source via hierarchical delta debugging (remove functions -> includes -> globals -> macros -> stub remaining).

### `transmuter ctl <action>`

HTTP client for the control server. Reads the discovery file, sends a request, and prints the JSON response. Designed for LLM agents and shell scripts.

---

## 13. HTTP Control Server (`--api`)

When `transmuter match` or `transmuter refine` is started with `--api`, a Hono HTTP server starts on `127.0.0.1` alongside the Ink dashboard. This allows external processes (e.g., an LLM agent via `curl` or `transmuter ctl`) to query session state and send control commands to a running session.

`GET /` returns a self-describing JSON listing all available endpoints with descriptions, so an LLM agent can discover the full API without any documentation.

### Discovery

On startup, the server writes a `transmuter-control.json` file next to the source file:

```json
{
  "pid": 12345,
  "port": 48201,
  "sessionId": "session-1712345678",
  "startedAt": "2026-04-02T10:30:00Z"
}
```

External processes read this file to discover the port. The file is deleted on clean exit. Stale files can be detected by checking if the PID is still alive.

Use the `GET /` to consult the API schema. It varies per session type (match vs refine).

### Architecture

The HTTP server runs in the same Bun process and event loop as the MutationSearch and Ink dashboard. It shares direct references to the `MutationSearch` and `SessionStore` instances — no IPC, serialization, or separate process. All handlers are thin wrappers around existing methods. Built with [Hono](https://hono.dev/) mounted on `Bun.serve` (no Node adapter). The `ctl` client is a small wrapper around the native `fetch`.

```
┌───────────────────────────────────────────────────┐
│                  CLI Process                       │
│                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │  Ink TUI     │  │  Mutation   │  │  Hono    │ │
│  │  (dashboard) │  │  Search     │  │  Server  │ │
│  │              │  │  (core)     │  │  (:port) │ │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘ │
│         │     events      │    methods     │       │
│         └────────◄────────┤────────◄───────┘       │
│                           │                        │
│  ┌──────────────┐         │                        │
│  │ SessionStore │◄────────┘                        │
│  └──────────────┘                                  │
└───────────────────────────────────────────────────┘
         ▲
         │  curl / transmuter ctl
┌────────┴──────────┐
│  External Process  │
│  (Claude Code)     │
└───────────────────┘
```

---

## 14. Compiler Setup

Compilers are vendored as git submodules under `compilers/` and built locally via `setup-compilers.sh`. No system-wide installation or environment variables are needed.

### Submodules

| Submodule | Path | Purpose |
|-----------|------|---------|
| [pret/agbcc](https://github.com/pret/agbcc) | `compilers/agbcc/` | GBA C compiler (ARM Thumb). Binary: `compilers/agbcc/agbcc` |
| [decompals/ido-static-recomp](https://github.com/decompals/ido-static-recomp) | `compilers/ido-static-recomp/` | N64 IDO 7.1 (static recompilation for modern platforms). Binaries: `compilers/ido-static-recomp/build/7.1/out/{cc,NCC,upas,...}` |

### `setup-compilers.sh`

Inspired by the [Klonoa: Empire of Dreams](https://github.com/Dream-Atelier/klonoa-empire-of-dreams) setup script:

1. Checks for `arm-none-eabi-as` and `make`
2. Runs `git submodule update --init`
3. Builds agbcc (`./build.sh`) with commit-hash caching
4. Builds IDO 7.1 (`make setup && make VERSION=7.1`) with commit-hash caching
5. On macOS, ensures Apple's `ar` is used (GNU `ar` from Homebrew produces archives that macOS `ld` cannot link)

### IDO Pascal

IDO's `cc` driver routes `.p` files to the `upas` (Pascal) frontend. The `USR_LIB` environment variable tells `cc` where to find `upas`. The shared compile script `compile-ido-pascal.sh` handles this:

```bash
USR_LIB="$IDO_DIR" "$IDO_DIR/cc" -c -mips2 -O2 -32 -o output.o input.p
```

IDO Pascal lowercases all symbol names (e.g., `IsPowerOfTwo` → `ispoweroftwo`). The Pascal function finder in `helpers.ts` uses case-insensitive regex matching to handle this.

### Test Fixtures

All fixtures use local compilers — no environment variables required. Run fixtures via:

```bash
pnpm run test:fixture                             # all 7 fixtures
pnpm run test:fixture -- --fade-out-controller     # single fixture
```

The runner script `scripts/run-fixtures.sh` dispatches to each fixture's `run-*.ts` script.

---

## 15. Compiler Target Profiles

Built-in profiles: `agbcc` (GBA), `old-agbcc`, `ido` (N64/IRIX), `mips-gcc-272` (N64 GCC 2.7.2), `base` (fallback).

Profile resolution: explicit `--profile` flag > compiler command auto-detection > `base` fallback.

---

## 16. objdiff-wasm Integration

Two layers wrap objdiff-wasm:

**`Objdiff`** (`scoring/objdiff.ts`) — low-level wrapper ported from Mizuchi. Provides:
- `parseObjectFile(path, side)` — parse a `.o` file into an objdiff Object
- `runDiff(left, right)` — run diff between two parsed objects
- `getSymbolNames(obj)` — extract all function/symbol names
- `getAssemblyFromSymbol(objDiff, name)` — convert instruction rows to readable assembly text
- `getDifferences(leftDiff, rightDiff, name)` — detailed categorized differences (INSERTION, DELETION, REPLACEMENT, OPCODE_MISMATCH, ARGUMENT_MISMATCH), also available as `structuredDifferences` with per-type counts

WASM module is lazily loaded once per process via a shared singleton. Bun's native `fetch` resolves `file://` URLs directly, so the loader is a plain `await import('objdiff-wasm')` — no monkey-patch required. (Historical note: Bun ≤ 1.2.19 additionally lacked `WebAssembly.compileStreaming`, which `objdiff-wasm`'s loader relies on via a `.then(WebAssembly.compileStreaming)` chain; Bun 1.3.12 ships it natively, so the former polyfill has also been removed.)

**`Scorer`** (`scoring/scorer.ts`) — higher-level class for the pipeline. Parses the target object once on `init()` and caches it. Provides:
- `score(candidateObjPath)` — returns numeric difference count
- `scoreWithAssembly(candidateObjPath)` — returns `AssemblyScoreResult` with `{ score, breakdown: DiffBreakdown, assembly, assemblyDiff }` in a single pass
- `assemblyDiff(candidateObjPath)` — returns side-by-side text diff

The pipeline uses `scoreWithAssembly()` so that every candidate gets its assembly data captured at creation time with zero extra cost.
