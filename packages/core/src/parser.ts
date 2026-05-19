/**
 * Multi-language parser setup for ast-grep.
 *
 * Registers tree-sitter grammars on first use:
 * - C: tree-sitter-c (existing)
 * - C++: @ast-grep/lang-cpp (official ast-grep package)
 * - Pascal: tree-sitter-pascal (Isopod/tree-sitter-pascal, Delphi/FPC grammar)
 */
import cppLang from '@ast-grep/lang-cpp';
import { type SgRoot, registerDynamicLanguage, parse as sgParse } from '@ast-grep/napi';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

import type { Language } from './language.js';

const registered = new Set<Language>();

function ensureCRegistered(): void {
  if (registered.has('c')) {
    return;
  }
  registered.add('c');

  const require = createRequire(import.meta.url);
  const pkgDir = path.dirname(require.resolve('tree-sitter-c/package.json'));
  const platform = os.platform();
  const arch = os.arch();
  const libPath = path.join(pkgDir, 'prebuilds', `${platform}-${arch}`, 'tree-sitter-c.node');

  registerDynamicLanguage({
    c: {
      libraryPath: libPath,
      extensions: ['c', 'h'],
      languageSymbol: 'tree_sitter_c',
    },
  });
}

function ensureCppRegistered(): void {
  if (registered.has('cpp')) {
    return;
  }
  registered.add('cpp');

  // @ast-grep/lang-cpp exports a LangRegistration object with the correct
  // libraryPath, extensions, and languageSymbol for the platform.
  registerDynamicLanguage({ cpp: cppLang });
}

function ensurePascalRegistered(): void {
  if (registered.has('pascal')) {
    return;
  }
  registered.add('pascal');

  const require = createRequire(import.meta.url);
  const pkgDir = path.dirname(require.resolve('tree-sitter-pascal/package.json'));
  // tree-sitter-pascal's node-gyp-build install script populates build/Release/
  const libPath = path.join(pkgDir, 'build', 'Release', 'tree_sitter_pascal_binding.node');

  registerDynamicLanguage({
    pascal: {
      libraryPath: libPath,
      extensions: ['pas', 'pp'],
      languageSymbol: 'tree_sitter_pascal',
    },
  });
}

/** Ensure the grammar for a language is registered. */
export function ensureLanguageRegistered(language: Language): void {
  switch (language) {
    case 'c':
      ensureCRegistered();
      break;
    case 'cpp':
      ensureCppRegistered();
      break;
    case 'pascal':
      ensurePascalRegistered();
      break;
  }
}

/** Parse source code in the given language into an ast-grep SgRoot. */
export function parse(language: Language, source: string): SgRoot {
  ensureLanguageRegistered(language);
  return sgParse(language, source);
}

/**
 * LRU-bounded cache for parsed SgRoots, keyed on (language, source).
 *
 * Rationale: during a mutation search the orchestrator iterates on the same
 * head-candidate source many times in a row — the source only changes when a
 * fork produces a new candidate. Re-parsing the full source (~45 ms on a
 * 426 KB ctx file) on every iteration dominates the non-compile CPU budget.
 *
 * SgRoot is read-only for rules (they call `.root().find(...)` and never
 * mutate the AST), so sharing a parse across iterations is safe.
 *
 * The cache is keyed on the raw source string. JS `Map` hashes string keys by
 * content (per the language spec), so the same source produced by different
 * code paths (slot A vs slot B, candidate vs mutation result) still hits.
 */
const PARSE_CACHE_MAX = 16;
const parseCache = new Map<string, SgRoot>();

/** Parse with LRU memoization. Safe for any caller that only reads the AST. */
export function parseCached(language: Language, source: string): SgRoot {
  const key = `${language}\0${source}`;
  const cached = parseCache.get(key);
  if (cached !== undefined) {
    // Touch: move to MRU end.
    parseCache.delete(key);
    parseCache.set(key, cached);
    return cached;
  }
  const root = parse(language, source);
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) {
      parseCache.delete(oldest);
    }
  }
  parseCache.set(key, root);
  return root;
}

/** Reset the parse cache. Used by tests that want deterministic timing. */
export function clearParseCache(): void {
  parseCache.clear();
}
