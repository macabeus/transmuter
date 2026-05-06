# Multi-language

Transmuter supports C, C++, and Pascal. Language is detected from the source file's extension; there is no `--language` flag.

```ts
type Language = 'c' | 'cpp' | 'pascal';
```

Core files:
- `packages/core/src/language.ts` — `Language` type + `detectLanguage(filePath)`.
- `packages/core/src/parser.ts` — grammar registration + `parse(language, source)`.
- `packages/core/src/rules/helpers.ts` — shared AST helpers (works across languages where possible).
- `packages/core/src/rules/pascal-helpers.ts` — Pascal-specific finders.

Long-form how-to: `docs/adding-a-language.md` in the repo root. This doc is the quick reference.

## Extension map

| Extension | Language |
|---|---|
| `.c`, `.h` | `c` |
| `.cpp`, `.cc`, `.cxx`, `.hpp` | `cpp` |
| `.pas`, `.pp` | `pascal` |

`detectLanguage` throws for unknown extensions with a message listing the supported ones.

## Grammar registration

Grammars register lazily on first use. `parse(language, source)` calls `ensureLanguageRegistered(language)` internally, so most callers don't need to register explicitly. `MutationSearch` and the other pipeline entry points still call it during initialization to surface registration errors up-front.

| Language | Package | Registration |
|---|---|---|
| C | `tree-sitter-c` | `registerDynamicLanguage()` loading `prebuilds/*/tree-sitter-c.node` |
| C++ | `@ast-grep/lang-cpp` | `registerDynamicLanguage({ cpp: cppLang })` from a static default import |
| Pascal | `tree-sitter-pascal` (Isopod/tree-sitter-pascal) | `registerDynamicLanguage()` loading `build/Release/tree_sitter_pascal_binding.node` |

All three are synchronous. `ensureLanguageRegistered` returns `void`, not `Promise<void>`.

## How language flows through the pipeline

```
CLI detects language from source file extension
  → MutationSearch constructor receives `language` option (defaults to 'c')
    → ensureLanguageRegistered(language) in start()
    → MutationEngine stores language, passes into MutationContext
    → RuleRegistry.getActiveRules(language) filters rules
    → SessionConfig.language stored in SessionReport
    → Compiler writes temp source with language-appropriate extension (.c, .cpp, .pas)
    → Webapp reads report.config.language to pick syntax highlighting
```

The pool, scoring, session store, HTTP API, and report JSON are all language-agnostic. Language awareness is confined to:

1. **`parser.ts`** — routes `parse(lang, source)` to the right grammar.
2. **Rules** — declare `languages: readonly Language[]`; engine filters via `RuleRegistry.getActiveRules(language)`.
3. **Guidelines** — same pattern; `GuidelineRegistry.list(language)` filters.
4. **`Compiler`** — picks the temp file extension from `LANG_EXT` (`.c` / `.cpp` / `.pas`) so compiler drivers like IDO's `cc`/`NCC` select the correct frontend.

## Pascal node-kind map

tree-sitter-pascal (Isopod/tree-sitter-pascal) targets Delphi/FreePascal. Node kinds differ substantially from C:

| Concept | C/C++ kind | Pascal kind |
|---|---|---|
| Function definition | `function_definition` | `defProc` |
| Function header | `function_declarator` | `declProc` |
| Block body | `compound_statement` | `block` |
| Binary expression | `binary_expression` | `exprBinary` |
| Function call | `call_expression` | `exprCall` |
| Call arguments | `argument_list` | `exprArgs` |
| Variable section | — | `declVars` |
| Variable declaration | `declaration` | `declVar` |
| Assignment | `assignment_expression` | `assignment` |

Use helpers from `pascal-helpers.ts` when writing Pascal-aware rules:

- `findPascalFunction(root, name)`
- `findPascalFunctionBody(root, name)` — returns the `block` node
- `getPascalStatements(block)` — filters out `begin`/`end`/`;` tokens
- `getPascalVarDeclarations(fn)` — walks `declVars` → `declVar`

## SGI Pascal / IDO quirks

- **Symbol names are lowercased.** IDO Pascal normalizes all identifiers to lowercase. `IsPowerOfTwo` in source becomes `ispoweroftwo` in the ELF symbol table. `findPascalFunction` matches **case-insensitively** to handle this. Don't "fix" this — it's required.
- **`cc` routes `.p` to `upas`.** IDO's `cc` driver dispatches by file extension: `.c` → `ccom`/`NCC`, `.p` → `upas`. The shared fixture script `test-fixture/shared/compile-ido-pascal.sh` sets `USR_LIB="$IDO_DIR"` so `cc` can find `upas`.
- **`.pas` vs `.p`:** Transmuter's `Compiler` writes `.pas` temps (see `LANG_EXT` in `compiler/compiler.ts`). If IDO only understands `.p`, the fixture's compile script has to rename on the fly. Check `test-fixture/shared/compile-ido-pascal.sh` for the pattern.
- **No inline asm.** Pascal has no equivalent of GCC's `__asm__`. Asm-specific rules (`asm-barrier`, `asm-register-swap`) and the `no-asm-pin` guideline are all C-only.

## Adding a new language (summary)

Full walk-through in `docs/adding-a-language.md`. Sketch:

1. Add the variant to `Language` union in `language.ts`.
2. Add file extensions to `EXTENSION_MAP`.
3. Pick a tree-sitter grammar (prefer `@ast-grep/lang-<lang>` if it exists). Add it as a `packages/core` dep via `pnpm add … --filter @transmuter/core`.
4. Add a `ensure<Lang>Registered()` function in `parser.ts` and wire it into the `ensureLanguageRegistered()` switch. Keep it synchronous — that's what every other language does.
5. Add helpers in `rules/helpers.ts` (or a new `<lang>-helpers.ts`) for finding the target function and iterating statements/declarations. Every rule starts by finding the target function — you must give rules a language-native way to do that.
6. Add the file extension to `LANG_EXT` in `compiler/compiler.ts` so temp files get the right suffix.
7. Add at least one rule and one guideline that declare the new language in their `languages` field.
8. Add a test fixture under `test-fixture/<lang>-<name>/` with a real compiler and target `.o`. Wire it into `scripts/run-fixtures.sh`.

## Pitfalls

- **Writing a C-only rule but declaring `['c', 'cpp']`.** The engine will hand your `apply()` a C++ `SgRoot`, which may have different child kinds than expected (e.g., qualified ids, templates). `findTargetFunction` in `helpers.ts` handles C++ mangled/qualified names; start there and test with a C++ fixture.
- **Pascal case sensitivity.** Any rule that compares function/variable names against the source must compare case-insensitively for Pascal, even though ast-grep itself is case-sensitive.
- **Language-specific node-kind typos.** ast-grep silently returns `[]` from `findAll({ rule: { kind: 'typo' } })`. Always add a positive test that fails loudly if the kind string is wrong.
