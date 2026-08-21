/**
 * Canonicalizer — deterministic AST simplification passes.
 *
 * Phase 1 of the cleanup pipeline. Applies a sequence of source-to-source
 * transformations, checking that each one preserves assembly output (score 0).
 * Runs passes in a loop until fixpoint (no pass makes progress).
 *
 * Passes (in order):
 * 1. do-while(0) unwrap — unwrap `do { body } while(0)` to just `body`
 * 2. Dead variable elimination — remove variables whose values are never used
 * 3. Single-use variable inlining — inline variables assigned once, used once
 * 4. Redundant cast removal — remove casts that don't change the type
 * 5. Whitespace normalization — collapse consecutive blank lines
 */
import type { SgRoot } from '@ast-grep/napi';
import { Compiler } from '~/compiler/compiler.js';
import type { Language } from '~/language.js';
import { parse } from '~/parser.js';
import { escapeRegex, findTargetFunction, getIndentation, getStatements, replaceRange } from '~/rules/helpers.js';
import { Scorer } from '~/scoring/scorer.js';

export interface CanonicalizerOptions {
  source: string;
  language: Language;
  functionName: string;
  /** Symbol name in the object file, if it differs (e.g. C++ mangling) */
  symbolName?: string;
  targetObjectPath: string;
  compilerCommand: string;
  cwd: string;
  sourcePrefix?: string;
  diffSettings?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (pass: string, applied: number) => void;
}

export interface CanonicalizerResult {
  source: string;
  passes: { name: string; applied: number }[];
  totalApplied: number;
}

type Pass = (source: string, root: SgRoot, functionName: string, language: Language) => PassCandidate[];

interface PassCandidate {
  source: string;
  description: string;
}

export class Canonicalizer {
  #opts: CanonicalizerOptions;
  #compiler: Compiler;
  #scorer: Scorer;

  constructor(opts: CanonicalizerOptions) {
    this.#opts = opts;
    this.#compiler = new Compiler({
      command: opts.compilerCommand,
      cwd: opts.cwd,
      functionName: opts.functionName,
      language: opts.language,
      signal: opts.signal,
      sourcePrefix: opts.sourcePrefix,
    });
    this.#scorer = new Scorer(opts.targetObjectPath, opts.symbolName ?? opts.functionName, opts.diffSettings);
  }

  async run(): Promise<CanonicalizerResult> {
    await this.#scorer.init();

    const passes: [string, Pass][] = [
      ['do-while-zero-unwrap', doWhileZeroUnwrap],
      ['dead-variable-elimination', deadVariableElimination],
      ['single-use-inline', singleUseInline],
      ['redundant-cast-removal', redundantCastRemoval],
      ['normalize-whitespace', normalizeWhitespace],
    ];

    let source = this.#opts.source;
    const passResults: { name: string; applied: number }[] = [];
    let totalApplied = 0;

    // Loop until fixpoint
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;

      for (const [name, passFn] of passes) {
        if (this.#opts.signal?.aborted) {
          break;
        }

        const root = parse(this.#opts.language, source);
        const candidates = passFn(source, root, this.#opts.functionName, this.#opts.language);
        let applied = 0;

        for (const candidate of candidates) {
          if (this.#opts.signal?.aborted) {
            break;
          }

          const safe = await this.#isAssemblyPreserving(candidate.source);
          if (safe) {
            source = candidate.source;
            applied++;
            madeProgress = true;
            // Re-run from the start of this pass's candidates since
            // source changed and offsets shifted. Break inner loop, the
            // outer fixpoint loop will re-enter this pass.
            break;
          }
        }

        if (applied > 0) {
          const existing = passResults.find((p) => p.name === name);
          if (existing) {
            existing.applied += applied;
          } else {
            passResults.push({ name, applied });
          }
          totalApplied += applied;
          this.#opts.onProgress?.(name, applied);
          // Source changed — restart the pass sequence from the beginning
          break;
        }
      }
    }

    await this.#compiler.destroy();

    return { source, passes: passResults, totalApplied };
  }

  async #isAssemblyPreserving(source: string): Promise<boolean> {
    const result = await this.#compiler.compile(source);
    if (!result.success) {
      return false;
    }
    const score = await this.#scorer.score(result.objPath);
    await Compiler.cleanup(result.objPath);
    return score === 0;
  }
}

// ---------------------------------------------------------------------------
// Pass: do-while(0) unwrap
// ---------------------------------------------------------------------------

function doWhileZeroUnwrap(source: string, root: SgRoot, functionName: string, _language: Language): PassCandidate[] {
  const fn = findTargetFunction(root, functionName);
  if (!fn) {
    return [];
  }

  const candidates: PassCandidate[] = [];
  const doStmts = fn.findAll({ rule: { kind: 'do_statement' } });

  for (const doStmt of doStmts) {
    const condition = doStmt.field('condition');
    if (!condition) {
      continue;
    }

    // Check if the condition is `0` (possibly wrapped in parens)
    const condChild =
      condition.kind() === 'parenthesized_expression'
        ? condition.children().find((c) => c.kind() !== '(' && c.kind() !== ')')
        : condition;
    if (!condChild || condChild.text() !== '0') {
      continue;
    }

    const body = doStmt.field('body');
    if (!body || body.kind() !== 'compound_statement') {
      continue;
    }

    // Extract the inner statements
    const stmts = getStatements(body);
    const indent = getIndentation(source, doStmt);
    const innerText = stmts.map((s) => indent + s.text()).join('\n');

    const range = doStmt.range();
    // Include the trailing semicolon after while(0)
    let endIdx = range.end.index;
    if (endIdx < source.length && source[endIdx] === ';') {
      endIdx++;
    }

    candidates.push({
      source: replaceRange(source, range.start.index, endIdx, innerText),
      description: `Unwrap do-while(0) at line ${range.start.line + 1}`,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pass: dead variable elimination
// ---------------------------------------------------------------------------

function deadVariableElimination(
  source: string,
  root: SgRoot,
  functionName: string,
  _language: Language,
): PassCandidate[] {
  const fn = findTargetFunction(root, functionName);
  if (!fn) {
    return [];
  }

  const candidates: PassCandidate[] = [];
  const body = fn.find({ rule: { kind: 'compound_statement' } });
  if (!body) {
    return [];
  }

  // Find all declaration statements
  const allDecls = fn.findAll({ rule: { kind: 'declaration' } });

  for (const decl of allDecls) {
    // Must have an init_declarator (i.e., `type name = value;`)
    const initDecl = decl.find({ rule: { kind: 'init_declarator' } });
    if (!initDecl) {
      continue;
    }

    const ident = initDecl.field('declarator');
    if (!ident || ident.kind() !== 'identifier') {
      continue;
    }

    const varName = ident.text();

    // Count all references to this variable in the function (excluding the decl)
    const refs = fn
      .findAll({ rule: { kind: 'identifier', regex: `^${escapeRegex(varName)}$` } })
      .filter((n) => n.range().start.index !== ident.range().start.index);

    // Check if all references are writes (LHS of assignments)
    const allRefsAreWrites = refs.every((n) => {
      const parent = n.parent();
      if (!parent) {
        return false;
      }
      // LHS of assignment
      if (parent.kind() === 'assignment_expression') {
        const left = parent.field('left');
        return left && left.range().start.index === n.range().start.index;
      }
      // In a declaration (re-declaration)
      if (parent.kind() === 'init_declarator') {
        const declr = parent.field('declarator');
        return declr && declr.range().start.index === n.range().start.index;
      }
      return false;
    });

    if (refs.length === 0 || allRefsAreWrites) {
      // Remove the declaration and all write-only references
      const range = decl.range();
      let startIdx = range.start.index;
      let endIdx = range.end.index;

      // Consume leading whitespace and trailing newline
      while (startIdx > 0 && source[startIdx - 1] !== '\n' && /\s/.test(source[startIdx - 1]!)) {
        startIdx--;
      }
      if (endIdx < source.length && source[endIdx] === '\n') {
        endIdx++;
      }

      candidates.push({
        source: replaceRange(source, startIdx, endIdx, ''),
        description: `Remove dead variable '${varName}' at line ${range.start.line + 1}`,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pass: single-use variable inlining
// ---------------------------------------------------------------------------

function singleUseInline(source: string, root: SgRoot, functionName: string, language: Language): PassCandidate[] {
  const fn = findTargetFunction(root, functionName);
  if (!fn) {
    return [];
  }

  const candidates: PassCandidate[] = [];
  const body = fn.find({ rule: { kind: 'compound_statement' } });
  if (!body) {
    return [];
  }

  const blocks = fn.findAll({ rule: { kind: 'compound_statement' } });

  for (const block of blocks) {
    const stmts = getStatements(block);

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]!;
      if (stmt.kind() !== 'declaration') {
        continue;
      }

      const initDecl = stmt.find({ rule: { kind: 'init_declarator' } });
      if (!initDecl) {
        continue;
      }

      const ident = initDecl.field('declarator');
      const value = initDecl.field('value');
      if (!ident || ident.kind() !== 'identifier' || !value) {
        continue;
      }

      const varName = ident.text();
      const valueText = value.text();

      // Find all uses of this variable after this declaration
      const uses = fn.findAll({ rule: { kind: 'identifier', regex: `^${escapeRegex(varName)}$` } }).filter((n) => {
        // Must be after the declaration
        if (n.range().start.index <= ident.range().start.index) {
          return false;
        }
        // Must not be LHS of assignment
        const parent = n.parent();
        if (parent && parent.kind() === 'assignment_expression') {
          const left = parent.field('left');
          if (left && left.range().start.index === n.range().start.index) {
            return false;
          }
        }
        // Must not be a declaration name
        if (parent && parent.kind() === 'init_declarator') {
          const declr = parent.field('declarator');
          if (declr && declr.range().start.index === n.range().start.index) {
            return false;
          }
        }
        return true;
      });

      // Check there are no writes (assignments) to this variable after the decl
      const writes = fn.findAll({ rule: { kind: 'identifier', regex: `^${escapeRegex(varName)}$` } }).filter((n) => {
        if (n.range().start.index <= ident.range().start.index) {
          return false;
        }
        const parent = n.parent();
        if (parent && parent.kind() === 'assignment_expression') {
          const left = parent.field('left');
          return left !== null && left.range().start.index === n.range().start.index;
        }
        return false;
      });

      if (uses.length === 1 && writes.length === 0) {
        const use = uses[0]!;
        // Inline: replace the use with the value, then remove the declaration
        let newSource = replaceRange(source, use.range().start.index, use.range().end.index, valueText);

        // Re-parse to remove the declaration (offsets shifted)
        const newRoot = parse(language, newSource);
        const newFn = findTargetFunction(newRoot, functionName);
        if (!newFn) {
          continue;
        }

        // Find the declaration to remove by matching variable name
        const declToRemove = newFn.findAll({ rule: { kind: 'declaration' } }).find((d) => {
          const init = d.find({ rule: { kind: 'init_declarator' } });
          if (!init) {
            return false;
          }
          const id = init.field('declarator');
          return id && id.text() === varName;
        });

        if (declToRemove) {
          let startIdx = declToRemove.range().start.index;
          let endIdx = declToRemove.range().end.index;
          while (startIdx > 0 && newSource[startIdx - 1] !== '\n' && /\s/.test(newSource[startIdx - 1]!)) {
            startIdx--;
          }
          if (endIdx < newSource.length && newSource[endIdx] === '\n') {
            endIdx++;
          }
          newSource = replaceRange(newSource, startIdx, endIdx, '');
        }

        candidates.push({
          source: newSource,
          description: `Inline single-use variable '${varName}' at line ${stmt.range().start.line + 1}`,
        });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pass: redundant cast removal
// ---------------------------------------------------------------------------

function redundantCastRemoval(
  source: string,
  root: SgRoot,
  functionName: string,
  _language: Language,
): PassCandidate[] {
  const fn = findTargetFunction(root, functionName);
  if (!fn) {
    return [];
  }

  const candidates: PassCandidate[] = [];
  const casts = fn.findAll({ rule: { kind: 'cast_expression' } });

  for (const cast of casts) {
    const value = cast.field('value');
    if (!value) {
      continue;
    }

    const range = cast.range();
    candidates.push({
      source: replaceRange(source, range.start.index, range.end.index, value.text()),
      description: `Remove cast at line ${range.start.line + 1}`,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pass: normalize whitespace
// ---------------------------------------------------------------------------

function normalizeWhitespace(source: string, root: SgRoot, functionName: string, _language: Language): PassCandidate[] {
  const fn = findTargetFunction(root, functionName);
  if (!fn) {
    return [];
  }

  // Find the function body range
  const body = fn.find({ rule: { kind: 'compound_statement' } });
  if (!body) {
    return [];
  }

  const fnRange = fn.range();
  const fnText = source.slice(fnRange.start.index, fnRange.end.index);

  // Normalize: collapse multiple blank lines into one, fix indentation
  const lines = fnText.split('\n');
  const normalized: string[] = [];
  let prevBlank = false;

  for (const line of lines) {
    const isBlank = line.trim() === '';
    if (isBlank && prevBlank) {
      continue; // Skip consecutive blank lines
    }
    normalized.push(line);
    prevBlank = isBlank;
  }

  const normalizedText = normalized.join('\n');
  if (normalizedText === fnText) {
    return [];
  }

  return [
    {
      source: replaceRange(source, fnRange.start.index, fnRange.end.index, normalizedText),
      description: 'Normalize whitespace',
    },
  ];
}
