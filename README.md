# Transmuter

<img src="./media/branding/logo.png" align="right" height="130px" />

> ⚗️ Mutate rough source into a perfect, golden match

Automatically mutates a source code to match a target binary's assembly, or refine its code quality while preserving the match. Focused on matching decompilation projects.

Main features:

- **Multi-language support:** C, C++, and Pascal
- **Swiss Army knife:** works for matching, source reduction, and post-match cleanup
- **Coding Agent-friendly:** plug in Claude Code or other agents via the built-in HTTP server to drive the search
- **Webapp for session reports:** explore mutation history, rule effectiveness, and score timelines interactively
- **Library-first design:** reuse the core mutation engine in your own tools and scripts

<img width="1321" height="1150" alt="image" src="https://github.com/user-attachments/assets/091f8871-cf49-4af9-8ead-9a89bda2eb61" />

> ⚙️ **What is Matching Decompilation?**
>
> Matching decompilation is the art of converting assembly back into C source code that, when compiled, produces byte-for-byte identical machine code. It’s popular in the retro gaming community for recreating the source code of classic games. For example, [Super Mario 64](https://github.com/n64decomp/sm64) and [The Legend of Zelda: Ocarina of Time](https://github.com/zeldaret/oot) have been fully match-decompiled.
>
> [Learn more by watching my talk.](https://www.youtube.com/watch?v=sF_Yk0udbZw)

## Setup

1. Add this repository as a submodule on your decomp project

```bash
git submodule add https://github.com/macabeus/transmuter.git tools/transmuter
```

2. Build Transmuter. Transmuter runs on [Bun](https://bun.com) and uses `pnpm` as its workspace manager. Drop the script below into a `setup-transmuter.sh` at your repo root, then run it. Re-run it any time you bump the submodule.

```bash
cat > setup-transmuter.sh <<'EOF'
#!/bin/bash
set -e

echo "Initializing tools/transmuter submodule..."
git submodule update --init tools/transmuter

if ! command -v bun &> /dev/null; then
  echo "[tools/transmuter] bun not found, installing..."
  curl -fsSL https://bun.com/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v pnpm &> /dev/null; then
  echo "[tools/transmuter] pnpm not found, installing globally..."
  bun install -g pnpm
fi

echo "[tools/transmuter] Installing dependencies..."
(cd tools/transmuter && pnpm install)

echo "[tools/transmuter] Building..."
(cd tools/transmuter && pnpm run build)
EOF
chmod +x setup-transmuter.sh
./setup-transmuter.sh
```

3. Invoke Transmuter via `bun`. The build produces a CLI entry at `tools/transmuter/packages/cli/dist/index.js`; run it with:

```bash
bun tools/transmuter/packages/cli/dist/index.js match ...
```

The rest of this README writes `transmuter ...` for brevity. Substitute `bun tools/transmuter/packages/cli/dist/index.js ...` when you run it.

4. Add a `tools.transmuter` section to your [`decomp.yaml`](https://github.com/ethteck/decomp_settings) with the compiler command and optional flags. Example for a GBA project using `agbcc`:

```yaml
platform: gba
# ...
tools:
  transmuter:
    # Shell command template for compiling a candidate source.
    # Use the placeholders `{{inputPath}}`, `{{outputPath}}`, and `{{functionName}}` as needed.
    compiler: |
      ASM_DIR="$(dirname "{{outputPath}}")"
      ASM_FILE="$ASM_DIR/$(basename "{{outputPath}}" .o).s"

      ./tools/agbcc/bin/agbcc \
        "{{inputPath}}" -o "$ASM_FILE" \
        -mthumb-interwork -Wimplicit \
        -Wparentheses -Werror -O2 -g -fhex-asm

      sed -i '' '/\.size/d' "$ASM_FILE"

      arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork "$ASM_FILE" -o "{{outputPath}}"
    # concurrency: 8 # Optional. Defaults to min(CPU count, 4)
    # noReduce: true # Optional. Skip source reduction (reduction runs by default; recommended on large files)
    # isolate: true # Optional. Strip non-target, non-inline function bodies + #defines before match
    # mutationDepth: 1 # Optional. Mutations chained per iteration
    # maxCompiles: 10000 # Optional. Stop after N compile attempts
    # timeoutMs: 60000 # Optional. Stop after N milliseconds
    # ruleWeights: # Optional. Override default rule weights for this project
    #   asm-barrier: 25
    #   pad-var-decl: 20
    # disabledRules: # Optional. Disable specific rules entirely
    #   - empty-stmt
```

> ⚠️ Real projects usually need more than a one-line compile step. Typical additions:
> - a `arm-none-eabi-cpp -nostdinc -I tools/agbcc/include -iquote include ...` preprocessing pass, because decomp source relies on project headers and macros like `INCLUDE_ASM`
> - appending `.text\n\t.align\t2, 0\n` to the generated assembly (needed by most `agbcc` setups to keep the literal pool aligned)
> - extra compiler flags your `Makefile` already passes (e.g. `-fprologue-bugfix`)
>
> A safe starting point is to copy the exact shell commands your `Makefile` uses to go from `.c` → `.o`, then replace the input/output paths with `{{inputPath}}` / `{{outputPath}}`.
>
> [See how KEoD does it as an example.](https://github.com/Dream-Atelier/kl-eod-decomp/blob/main/decomp.yaml)

5. Prepare a target object file for the function you want to match. Transmuter scores against a single `.o` on disk. A common recipe:

```bash
# For a GBA / agbcc project that stores nonmatching asm under `asm/nonmatchings/...`:
mkdir -p build/transmuter
cat > build/transmuter/target.s <<'EOF'
.include "asm/macros.inc"
.syntax unified
.text
.include "asm/nonmatchings/gfx/my_func.s"
EOF
arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork \
  build/transmuter/target.s -o build/transmuter/my_func.o
```

You can then pass `--target build/transmuter/my_func.o` to `transmuter match`. If your asm uses unified syntax (e.g. `lsls`, `orrs`, `adds`), remember the `.syntax unified` directive in the wrapper — `arm-none-eabi-as` rejects those mnemonics in the default divided mode.

6. Add Transmuter's scratch files to `.gitignore`. Every `transmuter match` / `refine` run writes two kinds of files **next to your source file**:

- `<function>-<score>.c` — the best candidate source
- `session-<timestamp>.json` — the session report consumed by the webapp

```gitignore
# Transmuter output
src/**/*-[0-9]*.c
src/**/session-*.json
```

### CLI

From the same directory as your `decomp.yaml`, you can run the following commands:

#### Matching

Use `transmuter match` to find a source code that compiles to identical assembly as the target object file.

```bash
# C source (default)
transmuter match base.c \
  --target target.o \
  --function my_func

# C++ source (language detected from .cpp extension)
transmuter match base.cpp \
  --target target.o \
  --function MyClass::update

# Pascal source (language detected from .pas extension)
transmuter match base.pas \
  --target target.o \
  --function UpdateEntity
```

**All flags:**

| Flag                      | Description                                                                                                         |
|---------------------------|---------------------------------------------------------------------------------------------------------------------|
| `--target <path>`         | Target object file (.o)                                                                                             |
| `--function <name>`       | Function name to match                                                                                              |
| `--compiler <cmd>`        | Compiler command template (`{{inputPath}}`, `{{outputPath}}`, `{{functionName}}`)                                   |
| `--cwd <path>`            | Working directory for the compiler                                                                                  |
| `--profile <id>`          | Compiler profile: `agbcc`, `old-agbcc`, `ido`, `mips-gcc-272`                                                       |
| `--concurrency <n>`       | Parallel slots, each running in its own worker thread (default: `min(CPU count, 4)`)                                |
| `--max-compiles <n>`      | Stop after N compile attempts (counts only mutations that survived dedup; no-mutation/dedup don't count)            |
| `--timeout <ms>`          | Stop after this many milliseconds                                                                                   |
| `--seed <n>`              | RNG seed for reproducible runs                                                                                      |
| `--depth <n>`             | Mutations to chain per iteration (default: 1)                                                                       |
| `--no-reduce`             | Skip source reduction before permuting                                                                              |
| `--isolate`               | Replace non-target, non-inline function bodies with forward declarations before reduce/match — useful on preprocessed `.ctx` files (macros are preserved) |
| `--no-cleanup`            | Skip cleanup after finding a match (do not remove temp vars, unnecessary casts)                                     |
| `--config <path>`         | Explicit path to `decomp.yaml`                                                                                      |
| `--version <name>`        | Version name for multi-version projects (selects the matching `versions[]` entry in `decomp.yaml`)                  |
| `--source-prefix <path>`  | File whose contents are prepended to every compiled candidate (typically `context.h`)                               |
| `--constraints <path>`    | JSON file with `focusConstraints` (focus-region, avoid-region, hypothesis) to bias mutation selection               |
| `--api`                   | Start HTTP control server for external access                                                                       |
| `--api-port <n>`          | Fixed port for the API server (default: random)                                                                     |

#### Refinement

If you already have a matching source but want to clean it up (e.g., remove `asm` pins, gotos, C-style casts), use `transmuter refine`:

```bash
transmuter refine base.c \
  --target target.o \
  --function my_func \
  --guideline no-asm-pin
```

Omit `--guideline` to list available guidelines with violation counts.

```bash
transmuter refine base.c \
  --target target.o \
  --function my_func
```

**All flags:**

| Flag                      | Description                                                                                            |
|---------------------------|--------------------------------------------------------------------------------------------------------|
| `--target <path>`         | Target object file (.o)                                                                                |
| `--function <name>`       | Function name to match                                                                                 |
| `--compiler <cmd>`        | Compiler command template                                                                              |
| `--guideline <id>`        | Guideline to apply (omit to list available)                                                            |
| `--cwd <path>`            | Working directory for the compiler                                                                     |
| `--profile <id>`          | Compiler profile                                                                                       |
| `--concurrency <n>`       | Total concurrent slots (default: `min(CPU count, 4)`)                                                  |
| `--max-compiles <n>`      | Max compile attempts per violation (default: unlimited)                                                |
| `--timeout <ms>`          | Max time per violation in ms (default: unlimited)                                                      |
| `--seed <n>`              | RNG seed for reproducibility                                                                           |
| `--skip-merge`            | Only run Phase 1 exploration, skip merge phase                                                         |
| `--no-cleanup`            | Skip cleanup after refinement                                                                          |
| `--constraints <path>`    | JSON file with `focusConstraints` and/or `violationHypotheses` to guide each violation's sub-search    |
| `--config <path>`         | Explicit path to `decomp.yaml`                                                                         |
| `--source-prefix <path>`  | File whose contents are prepended to every compiled candidate                                          |
| `--api`                   | Start HTTP control server                                                                              |
| `--api-port <n>`          | Fixed port for the API server (default: random)                                                        |

#### Viewing a report

Every `transmuter match` or `transmuter refine` runs produces a JSON report file alongside the source file (e.g., `session-1711843200000.json`). The report captures the critical improvement chain with diffs, per-rule statistics, branch lifecycle, and score timeline. They are useful for understanding how a match was found and provide insights.

Use the built-in webapp to browse session reports in your browser:

```bash
# Dev mode — hot-reloads when the JSON file changes (faster)
pnpm run dev:webapp ./session-1711843200000.json

# Build a self-contained HTML file (no server required, shareable)
pnpm run build:webapp
```

#### macOS: enable Developer Tools (recommended)

Transmuter spawns hundreds of compiler processes per second. On macOS, each process spawn triggers a code signature verification by `syspolicyd`. After a long run, it can cause a perceptible performance degradation.

The fix: enable **Developer Tools mode**, which exempts processes launched from your terminal from the expensive re-verification:

```bash
sudo DevToolsSecurity -enable
```

Then go to **System Settings > Privacy & Security > Developer Tools** and toggle on your terminal app (Rio, Warp, Terminal.app, etc.).

## Profiles

Profiles tune the initial mutation weights for specific compilers. Transmuter auto-detects the profile from `decomp.yaml`.

Check the active profile, rules and weights on your project by running `transmuter profile-detect`.

## Automation

### API server

You can enable a local HTTP control server using the `--api` flag when starting `transmuter match` or `transmuter refine`.

```bash
# Start with the API enabled
transmuter match base.c --target target.o --function my_func --compiler "..." --api

# The dashboard shows the API endpoint:
#   API: http://127.0.0.1:48201 — /path/to/transmuter-control.json
```

It has two main purposes:

#### LLM integration

A coding agent like Claude Code can be used to guide Transmuter automatically.

Prompt example:

```md
The `transmuter` tool is running a mutation search to match a function's assembly output.
It exposes a JSON API for control and querying. The API discovery file is located at `/path/to/transmuter-control.json`.
You can use this API to check the current best candidate, view assembly diffs, and inject new code as branches in the search.
```

#### Manual control

You can control manually a running session using the `transmuter ctl` command.

```bash
# Check the current session state
transmuter ctl session

# Get the best candidate's source
transmuter ctl best

# Prune branches with score >= 40 (single command replaces N disable calls)
transmuter ctl prune 40

# Keep only the 10 best branches
transmuter ctl prune best 10

# View assembly diff for a candidate
transmuter ctl assembly candidate-67

# Inject code from a file
transmuter ctl inject-file hypothesis.c "claude-hypothesis"

# Point to a specific discovery file
transmuter ctl session --control-file /path/to/transmuter-control.json
```

Run `transmuter ctl --help` for the full list of actions.

### Library

You can use Transmuter as a library in your own tools and scripts. The core class is `MutationSearch`, which exposes the full mutation engine with fine-grained control.

```typescript
import { MutationSearch } from '@transmuter/core';

const search = new MutationSearch({
  source: cCode,
  functionName: 'sub_807ECFC',
  targetObjectPath: './target.o',
  compilerCommand: 'agbcc -O2 -mthumb {{inputPath}} -o {{outputPath}}',
  cwd: '/path/to/project',
  profile: 'agbcc',
  concurrency: 4,
  maxCompiles: 10_000,
  onEvent(event) {
    if (event.type === 'forked') {
      console.log(`Score: ${event.oldScore} -> ${event.newScore} (${event.ruleId})`);
    }
  },
});

const result = await search.start();
console.log(`Best score: ${result.bestScore}, iterations: ${result.totalIterations}`);
```

While running, consumers can interact with the `MutationSearch` instance:

```typescript
search.stop();                               // Graceful stop
search.pause();                              // Pause all slots
search.resume();                             // Resume
await search.injectCode(betterSource);       // Add external code as a new branch
search.updateWeights({ 'asm-barrier': 30 }); // Adjust weights at runtime
search.disableRule('pad-var-decl');          // Disable a rule
search.summarize();                          // Manually compact dead branches
const state = search.getState();             // Snapshot of current state
```

Check on the [library documentation](./docs/library.md) for more detail and APIs.

## Mutation rules

Transmuter ships 49 built-in rules across three languages. Each rule declares which languages it supports and has a default weight that determines how often it's selected. Only rules matching the source language are active during a session. Profiles override defaults for specific compilers.

A rule can also be filtered by diff-type affinity. For example, the rule `add-sub-swap` is enabled if the diff type includes an `opMismatch`.

You can override weights via `decomp.yaml`, CLI, or the library API:

```yaml
# decomp.yaml
tools:
  transmuter:
    ruleWeights:
      asm-barrier: 30
      pad-var-decl: 0   # disable
    disabledRules:
      - empty-stmt
```

### C / C++ rules

| Rule | Description | Default weight | Languages | Diff-type affinity |
|------|-------------|---------------|-----------|-------------------|
| `temp-for-expr` | Extract expression into temporary variable | 100 | C, C++ | insert, delete, argMismatch |
| `expand-expr` | Replace a variable reference with its assigned value (inline expansion) | 80 | C, C++ | insert, delete, argMismatch |
| `randomize-type` | Randomize the type of a local variable declaration | 50 | C, C++ | — |
| `reorder-stmts` | Swap adjacent statements | 30 | C, C++ | argMismatch |
| `reorder-decls` | Swap adjacent declarations | 20 | C, C++ | argMismatch |
| `cast-expr` | Add or modify type cast on expression | 20 | C, C++ | opMismatch, argMismatch |
| `remove-cast` | Remove unnecessary type casts | 20 | C, C++ | opMismatch, argMismatch |
| `asm-barrier` | Insert `asm("" : "+r"(var))` register barrier | 15 | C | argMismatch |
| `add-mask` | Add bitwise AND mask (e.g., `& 0xFF`) | 15 | C, C++ | — |
| `commutative-swap` | Reorder operands of commutative ops | 15 | C, C++ | argMismatch |
| `modify-condition` | Modify a conditional expression (double negate, explicit zero comparison) | 15 | C, C++ | opMismatch, argMismatch |
| `explicit-this` | Add or remove explicit `this->` on member access | 15 | C++ | — |
| `insert-block` | Wrap statement in `do {} while(0)` or `if (1) {}` | 10 | C, C++ | opMismatch, insert, delete |
| `struct-ref-swap` | Convert between `a->b` and `(*a).b` | 10 | C, C++ | opMismatch, argMismatch |
| `add-sub-swap` | Convert `a - b` to `a + (-b)` or vice versa | 10 | C, C++ | opMismatch |
| `inequality-swap` | Swap `a < b` to `b > a` (flip operator + operands) | 10 | C, C++ | opMismatch |
| `split-assignment` | Split `a = b.c.d` into temp assignments | 10 | C, C++ | insert, delete, argMismatch |
| `chain-assignment` | Combine `a = x; b = x;` into `a = b = x;` | 10 | C, C++ | insert, delete, argMismatch |
| `pad-var-decl` | Insert unused padding variable (stack adjustment) | 10 | C, C++ | argMismatch |
| `asm-register-swap` | Swap register constraint in existing `asm()` | 10 | C | argMismatch |
| `shift-div-swap` | Convert `x >> N` to `x / 2^N` or vice versa | 10 | C, C++ | opMismatch |
| `compound-return` | Convert `return (cast)(x OP y)` to `return x OP= y` or vice versa | 10 | C, C++ | opMismatch, argMismatch |
| `cast-style-swap` | Convert between C-style casts and `static_cast` | 10 | C++ | opMismatch, argMismatch |
| `reorder-field-init` | Reorder field initializers in constructor | 10 | C++ | — |
| `sameline` | Combine two adjacent statements onto the same line | 5 | C, C++ | argMismatch |
| `delete-stmt` | Remove a random statement (if, expression, loop) | 5 | C, C++ | opMismatch, insert, delete |
| `self-assignment` | Insert `a = a;` (register allocation hint) | 5 | C, C++ | argMismatch |
| `duplicate-assignment` | Duplicate an assignment statement by inserting a copy after it | 5 | C, C++ | insert, delete, argMismatch |
| `long-chain-assignment` | Chain 3+ consecutive assignments with identical RHS into one | 5 | C, C++ | insert, delete, argMismatch |
| `factor-mult` | Expand `a * N` into `a * (N-1) + a` or `a * (N+1) - a` | 5 | C, C++ | opMismatch |
| `factor-shift` | Convert between shift and multiplication (`a << N` to `a * 2^N`) | 5 | C, C++ | opMismatch |
| `void-cast` | Wrap call expression with `(void)` | 5 | C, C++ | insert, delete |
| `empty-stmt` | Insert empty statement `;` | 3 | C, C++ | insert, delete |
| `xor-zero` | Add `^ 0` to a random expression | 3 | C, C++ | — |
| `mult-zero` | Add an identity operation (`* 1`, `+ 0`, `\| 0`, `- 0`) to a random expression | 3 | C, C++ | — |
| `refer-to-var` | Create a pointer to a local variable and dereference one usage | 3 | C, C++ | — |
| `float-literal` | Randomize float literal representation | 3 | C, C++ | — |
| `comma-expr` | Wrap an expression with a comma operator: `(0, expr)` | 3 | C, C++ | — |
| `extra-parens` | Add extra parentheses around an expression | 3 | C, C++ | — |

### Pascal rules

| Rule | Description | Default weight | Diff-type affinity |
|------|-------------|---------------|-------------------|
| `pascal-reorder-stmts` | Swap adjacent statements in begin/end block | 30 | argMismatch |
| `pascal-reorder-vars` | Swap adjacent var declarations | 20 | argMismatch |
| `pascal-commutative-swap` | Reorder operands of commutative ops | 15 | argMismatch |
| `pascal-type-cast` | Add or remove function-style type cast | 15 | opMismatch, argMismatch |
| `pascal-extra-parens` | Add or remove extra parentheses | 10 | — |
| `pascal-bool-negate` | Negate boolean expression with `not` | 10 | opMismatch |
| `pascal-arith-shift` | Swap between `shl`/`shr` and `*`/`div` by powers of 2 | 10 | opMismatch |
| `pascal-loop-swap` | Convert between `while` and `repeat..until` | 10 | opMismatch, insert, delete |
| `pascal-intrinsic-swap` | Swap between equivalent intrinsic calls | 10 | — |
| `pascal-begin-wrap` | Wrap single statement in begin/end block | 10 | opMismatch, insert, delete |

## How it works

### Overview

1. **Parse** the source with [ast-grep](https://ast-grep.github.io/) (tree-sitter under the hood — grammar selected by language)
2. **Select** a branch from the pool (fitness-proportional: lower score = higher selection probability, with 10% random exploration)
3. **Mutate** by picking a rule (filtered by diff-type affinity, then selected via per-target Thompson Sampling) and applying it to the AST
4. **Deduplicate** via a content hash — skip if an identical source was already compiled
5. **Compile** via the user's compiler command (runs as a subprocess)
6. **Score** using [objdiff](https://github.com/encounter/objdiff) — count instruction-level differences against the target
7. **Update** the pool: if the score improved, the branch adopts the new code
8. **Auto-compact**: periodically prune stale branches (many attempts without improvement) and free their memory
9. **Repeat** across N concurrent slots until score reaches 0 (perfect match), iteration/time limit, or manual stop

The pool maintains multiple branches simultaneously. Stale branches are automatically pruned and compacted into lightweight summary nodes, keeping memory bounded in long-running sessions. When external code is injected (e.g., from an LLM via the library API), it enters as a new branch competing with mutation-discovered candidates.

Check [`architecture.md`](./.claude/docs/architecture.md) for a deep dive into the glossary, internal architecture, data flow, and design rationale.

### Source reduction

When `reduce` is enabled (i.e., `--no-reduce` is not specified), Transmuter shrinks a C file before permuting. Smaller files compile faster, so this is a significant speedup for large compilation units.

The algorithm runs five phases:

1. **Remove non-target functions** (try all at once, then binary search for needed ones)
2. **Remove `#include` directives** (one at a time)
3. **Remove global declarations** (variables, typedefs, structs)
4. **Remove `#define` macros**
5. **Stub remaining functions** (replace bodies with `{}` or `{ return 0; }`)

After each removal, the file is compiled and scored. If the score is unchanged, the removal is safe.

### Source cleanup

When `cleanup` is enabled (i.e., `--no-cleanup` is not specified), Transmuter simplifies matching code while preserving the assembly output. Transmuter's mutations often find matches through non-obvious paths — inserting temp variables, wrapping in `do { ... } while(0)`, adding redundant casts. Cleanup removes these artifacts.

The cleanup runs in two phases:

1. **Canonicalization** (fast) — deterministic AST passes: unwrap `do-while(0)`, eliminate dead variables, inline single-use variables, remove redundant casts, normalize whitespace. Each transformation is verified by recompiling and checking the assembly stays identical.

2. **Smell-budget permutation** (slower, only if needed) — runs the mutation engine with simplifying rules boosted and additive rules disabled, optimizing for a "smell score" (weighted count of temp variables, casts, `do-while(0)`, etc.) while keeping the assembly output at score 0. This handles constructive rewrites that Phase 1 can't (e.g., converting `>> 8` to `/ 256`).

## FAQ

**What do the scores mean?**

Scores are instruction-level difference counts from [objdiff](https://github.com/encounter/objdiff/). Each instruction where the candidate differs from the target (wrong opcode, wrong argument, inserted, deleted) adds 1 to the score. A score of 0 means the function's assembly matches the target exactly.

**What kinds of non-matchings is Transmuter good at?**

Transmuter works best toward the end of matching — when the logic is correct but register allocation, instruction ordering, or stack layout differences remain. It's less effective at fixing functional/algorithmic differences. Use it as a complement to manual matching, not a replacement.

**How do I reproduce a specific result?**

Pass `--seed <n>` with the same seed, concurrency, and source. The RNG is deterministic — same inputs produce the same mutation sequence.

**What is adaptive selection?**

Per-target Thompson Sampling is always active. The engine learns which rules are effective for each branch and adapts selection probabilities over time. Early in a session it explores uniformly; as data accumulates it focuses on productive rules.

**What is auto-compact?**

Auto-compact automatically prunes stale branches and frees their memory during the search. It's enabled by default. The staleness threshold is **adaptive**: it lowers as the target pool grows (compensating for per-target attempt dilution) and rises as the pool shrinks (preventing over-pruning). With defaults, a pool of 500 targets prunes branches after ~45 fruitless attempts, while a pool of 4 targets requires ~500. This self-stabilizing behavior keeps memory bounded in long-running sessions without over-pruning small pools. The best 3 branches are always kept alive. You can tune this via `autoCompact` in `MutationSearchOptions`, or disable it with `autoCompact: false`.

**How to add a new mutation rule/language/guideline/profile?**

Check the documentation in the [documentation folder](./docs/) for step-by-step guides on how to contribute.
