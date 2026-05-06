# Mutation plugins

A mutation rule is a stateless object implementing `Rule` from `packages/core/src/rules/rule.ts`. The engine picks one rule per iteration via Thompson Sampling, calls `apply(ctx)`, and — if the result compiles and scores better — forks a new candidate.

Existing long-form how-to: `docs/adding-rules.md` in the repo root has a step-by-step walkthrough. This file is the quick reference.

## The interface

```ts
interface Rule {
  readonly id: string;                              // kebab-case, unique
  readonly description: string;                    // one sentence
  readonly languages: readonly Language[];          // ['c'], ['c','cpp'], ['pascal']
  readonly defaultWeight: number;                   // higher = picked more often; 0 = disabled by default
  readonly relevantDiffTypes?: ReadonlySet<DiffType>; // filter: skip when no matching diffs remain
  apply(ctx: MutationContext): MutationApplyResult | null;
}

interface MutationContext {
  readonly source: string;
  readonly root: SgRoot;                // pre-parsed ast-grep AST (read-only)
  readonly rng: Rng;                    // seeded PRNG — use rng.pick(), never Math.random()
  readonly functionName: string;        // bound the mutation to this function
  readonly language: Language;
  readonly nodeFilter?: NodeFilter;     // bias toward focus regions when present
}

interface MutationApplyResult {
  source: string;                                    // mutated source
  location: { line: number; column: number };       // 1-indexed, for fork dedup
}
```

Return `null` generously — the engine will try another rule (up to 10 attempts per slot). Null is normal, not an error.

## Key rules of the road

- **Scope to the target function.** Always start with `findTargetFunction(root, functionName, language)`. Don't mutate code outside it — you'll break unrelated code and waste iterations.
- **Use `rng`, never `Math.random()`.** Seeded reproduction depends on it.
- **Location is 1-indexed.** ast-grep ranges are 0-indexed — add 1 to both `line` and `column` in the returned location. This is what drives fork dedup (`scoreDelta:ruleId:line:column`), so inconsistent location reporting produces duplicate forks.
- **Guard against asm regions.** For any rule that edits expressions, call `isInsideAsm(node)` before accepting the candidate — otherwise you'll randomize inline asm operands and confuse yourself.
- **Mark diff-type affinity when possible.** If your rule only affects register allocation, declare `relevantDiffTypes: new Set(['argMismatch'])`. The engine will skip it when the candidate has no argMismatch diffs left, saving attempts. Rules without this field are always eligible.
- **Test deterministically.** Use `new Rng(42)` in tests. Different seeds exercise different paths in rules that branch on `rng.pick`.

## File layout

```
packages/core/src/rules/
  rule.ts                    # the Rule interface
  engine.ts                  # MutationEngine — applies rules, handles depth + retries
  registry.ts                # RuleRegistry — weights, enable/disable, profile application
  adaptive-selector.ts       # per-target Thompson Sampling (always on)
  helpers.ts                 # findTargetFunction, replaceRange, swapRanges, isInsideAsm, getIndentation
  pascal-helpers.ts          # Pascal-specific node finders
  built-in/
    index.ts                 # barrel — register new rules here
    <rule-name>.ts           # one file per rule
    <rule-name>.spec.ts      # co-located test
```

## Canonical reference examples

- **Simple commutative swap (C/C++)** — `packages/core/src/rules/built-in/commutative-swap.ts`. Finds `binary_expression` nodes with commutative operators, swaps left/right, guards against self-swap.
- **Statement reordering** — `packages/core/src/rules/built-in/reorder-stmts.ts`. The cleanest example of "find sibling nodes, swap two at random".
- **C++-only rule** — `packages/core/src/rules/built-in/explicit-this.ts`. Shows how to gate on language and use the C++ grammar specifically.
- **Pascal rule** — `packages/core/src/rules/built-in/pascal-reorder-stmts.ts`. Uses `getPascalStatements` from `pascal-helpers.ts` because Pascal `begin`/`end` blocks have different child node kinds than C `{}`.
- **Rule with declared affinity** — `packages/core/src/rules/built-in/shift-div-swap.ts` (opMismatch target). Compare to `commutative-swap.ts` which declares `argMismatch`.

## Adding a new rule (checklist)

1. Create `packages/core/src/rules/built-in/<rule-name>.ts`.
2. Implement the `Rule` interface. Use helpers from `../helpers.js` (and `../pascal-helpers.js` for Pascal).
3. Add a co-located `<rule-name>.spec.ts`. At minimum: one positive test showing the mutation fires, one negative test returning null. Use `parse(<language>, source)` from `~/parser.js` — it auto-registers the grammar.
4. Register in `packages/core/src/rules/built-in/index.ts` — import, add to `builtInRules`, add to the re-exports.
5. **Update the count** in the barrel file's comment (currently `/** All 49 built-in mutation rules. */`).
6. If the rule is compiler-specific, consider adding it to a profile's `ruleWeights` in `packages/core/src/profiles/` (e.g., `agbcc.ts` boosts asm-barrier to 25). Or disable it in profiles where it's unsafe — `ido.ts` disables `asm-barrier` because IDO doesn't understand GCC asm syntax.

## ast-grep cheat sheet

Rules use ast-grep's NAPI bindings (`@ast-grep/napi`). Common patterns:

```ts
// Find all nodes of a kind
const nodes = fn.findAll({ rule: { kind: 'binary_expression' } });

// First match only
const node = fn.find({ rule: { kind: 'return_statement' } });

// Named field access
const left = node.field('left');   // SgNode | null
const right = node.field('right');

// Position-based children (0-indexed)
const children = node.children();   // SgNode[]

// Text + range
const text = node.text();
const range = node.range();        // { start: { line, column, index }, end: {...} }
```

Node kinds are tree-sitter specific. C uses `binary_expression`, `declaration`, `compound_statement`, etc. Pascal uses `exprBinary`, `declVar`, `block`, `defProc` — see `architecture.md` §3 for the full map. For quick discovery, print `node.kind()` during development.

## Weight tuning

- Default weights live on the rule itself (`defaultWeight`).
- Profiles override defaults: `packages/core/src/profiles/<profile>.ts` defines `ruleWeights` and `disabledRules`.
- User `--rule-weights` at runtime is the highest-precedence override (see `RuleRegistry.getWeight` precedence: disabled → user → profile → rule default).
- Adaptive Thompson Sampling is **always** on and operates on top of the static weights — you don't tune it manually. It learns which rules fork for which target.

## Pitfalls

- **Applying a rule in place** in the ast-grep tree: the `root` is read-only. Rules must return a new source string, not mutate nodes.
- **Forgetting `.join('\n')`** when reconstructing source from lines. The engine compares whole strings for dedup; a trailing-newline diff is still a diff.
- **Off-by-one on ranges.** `range().start.index` and `range().end.index` are the correct character offsets for `replaceRange`. Line/column are separate fields.
- **Using `isInsideAsm` only for C.** For C++ you may also want to skip `gnu_asm_expression`; for Pascal there's no inline asm concept, so no guard is needed.
