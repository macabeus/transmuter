# Development

```bash
git clone <repo-url>
cd transmuter
pnpm install

# Build
pnpm run build              # Build core + CLI
pnpm run build:webapp       # Build webapp (self-contained HTML)

# Test
cd packages/core && pnpm vitest run  # Run core tests
cd packages/core && pnpm vitest      # Watch mode

# Type check
pnpm run check-types        # Check both packages

# Dependency layer check
pnpm --filter @transmuter/core run check-deps

# Webapp dev server (browse a session report with hot reload)
pnpm run dev:webapp -- ./path/to/session-report.json
```

## Dependency Layers (`@transmuter/core`)

The core package is organized into four layers. Each layer may only depend on layers below it — never above. This is enforced by [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) via `packages/core/.dependency-cruiser.cjs`.

```
L3  Orchestration    search/  refiner/  cleanup/  reducer/
     │
L2  Domain           rules/  guidelines/  pipeline/  session/
     │
L1  Infrastructure   parser.ts  compiler/  scoring/  profiles/
     │
L0  Foundation       types.ts  language.ts  rng.ts
```

### L0 — Foundation

No internal dependencies. Defines the vocabulary used everywhere.

| Module | Purpose |
|--------|---------|
| `types.ts` | All shared types and interfaces |
| `language.ts` | Language enum (`'c' \| 'cpp' \| 'pascal'`) and file extension detection |
| `rng.ts` | Seeded PRNG (xoshiro256\*\*) for deterministic reproduction |

### L1 — Infrastructure

Depends on L0 only. Wraps external systems (compilers, WASM, tree-sitter).

| Module | Purpose |
|--------|---------|
| `parser.ts` | ast-grep/tree-sitter parser setup (lazy registration per language) |
| `compiler/` | Shell-based compiler wrapper (temp dir reuse, concurrent file naming) |
| `scoring/` | `@match-kit/scoring` wrapper for assembly diff scoring |
| `profiles/` | Compiler profile detection (agbcc, IDO, MIPS GCC, etc.) |

### L2 — Domain

Depends on L0–L1. Contains the core domain logic. Horizontal dependencies within L2 are constrained — see below.

| Module | Purpose |
|--------|---------|
| `rules/` | Mutation rule system: `Rule` interface, `RuleRegistry`, `MutationEngine`, `AdaptiveSelector`, `CompositeNodeFilter`, 49 built-in rules |
| `guidelines/` | Guideline system: `Guideline` interface, violation detection and removal, 4 built-in guidelines |
| `pipeline/` | Candidate DAG (`Pool`), SHA-256 deduplication (`Deduplicator`) |
| `session/` | Event-sourced session capture (`SessionStore`), collapsed graph for visualization |

### L3 — Orchestration

Depends on everything below. Wires L2 components into executable workflows.

| Module | Purpose |
|--------|---------|
| `search/` | `MutationSearch` (main orchestrator) and `SlotOrchestrator` (concurrent mutation slots) |
| `refiner/` | Two-phase violation fixer (parallel exploration + sequential merge) |
| `cleanup/` | Post-match code simplification (canonicalization + smell permutation) |
| `reducer/` | Hierarchical delta debugging for source minimization |

### Intra-layer rules (L2)

Within L2, not all cross-folder imports are allowed:

| From | Cannot import | Why |
|------|---------------|-----|
| `pipeline/` | `rules/`, `guidelines/` | Pool and dedup are pure data structures — they don't know about mutation rules |
| `session/` | `rules/`, `pipeline/` | Session reporting consumes events via types, not via direct module references |

### Plugin isolation

Built-in rules (`rules/built-in/*.ts`) and built-in guidelines (`guidelines/built-in/*.ts`) must not import from each other — only from their respective interfaces, helpers, and L0–L1 modules. This keeps each plugin self-contained.

### Checking and visualizing

```bash
# Validate all layer boundaries
pnpm --filter @transmuter/core run check-deps

# Generate a dependency graph SVG (requires graphviz)
pnpm --filter @transmuter/core exec depcruise src \
  --config .dependency-cruiser.cjs --output-type dot | dot -T svg > deps.svg
```

### Adding new modules

When adding a new folder to `packages/core/src/`:

1. Decide which layer it belongs to
2. Add it to the appropriate path patterns in `.dependency-cruiser.cjs`
3. If it's an L3 orchestrator, add it to the `domain-no-orchestration-deps` rule's `to` path
4. If it's an L2 domain module, consider adding intra-layer constraints
5. Run `check-deps` to verify
