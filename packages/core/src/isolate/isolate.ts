/**
 * Isolate a target function from its surrounding translation unit.
 *
 * Given a (possibly preprocessed) C source and the name of a target function,
 * returns an equivalent source where every non-target, non-inline function
 * body has been replaced with `;` — turning the definition into a forward
 * declaration. The target function and any `inline` function bodies are
 * preserved verbatim.
 *
 * The resulting source compiles to the same bytes for the target symbol as
 * the original, but skips codegen for every other function. This makes it a
 * useful pre-step for `Reducer` or `MutationSearch` when the input is a
 * large preprocessed `.ctx` file.
 *
 * Why keep `inline` bodies? mwcc (and other compilers with `-inline auto`)
 * may inline a small `static inline` callee into the target function, in
 * which case stubbing the callee would change the target's compiled bytes
 * and break the match. Non-inline calls emit a plain `bl <symbol>` — their
 * bodies don't affect codegen.
 *
 * Why not strip `#define`s? Inlined headers (`ctype.h`, `math.h`, …) often
 * keep small `inline` functions whose bodies still depend on macros from the
 * same header. Stripping the macros breaks compilation. Macros are cheap to
 * tokenize, so the pragmatic trade-off is to leave them alone.
 */
import { parse } from '../parser.js';
import { getCFunctionName } from '../rules/helpers.js';

export interface IsolateResult {
  /** The isolated source. */
  source: string;
  /** Number of function bodies stripped to declarations. */
  bodiesStripped: number;
}

const INLINE_SPECIFIERS = new Set(['inline', '__inline', '__inline__']);

/**
 * Isolate `functionName` in `source`.
 *
 * Throws if the target function is not found.
 */
export function isolateFunction(source: string, functionName: string): IsolateResult {
  const root = parse('c', source);
  const fnDefs = root.root().findAll({ rule: { kind: 'function_definition' } });

  const targetFn = fnDefs.find((fn) => getCFunctionName(fn) === functionName);
  if (!targetFn) {
    throw new Error(`isolateFunction: target function '${functionName}' not found in source`);
  }

  type Edit = { start: number; end: number; replacement: string };
  const edits: Edit[] = [];

  let bodiesStripped = 0;
  for (const fn of fnDefs) {
    if (fn === targetFn) {
      continue;
    }

    const body = fn.find({ rule: { kind: 'compound_statement' } });
    if (!body) {
      continue;
    }

    // `inline` (or `__inline` / `__inline__`) on this function means the
    // compiler may inline it into the target — we must keep the full body.
    // Check the AST directly so a stray `/* not inline */` comment between
    // the declarator and body isn't picked up by a textual scan.
    const isInline = fn
      .children()
      .some((c) => c.kind() === 'storage_class_specifier' && INLINE_SPECIFIERS.has(c.text()));
    if (isInline) {
      continue;
    }

    // Pull the start back over any whitespace between the declarator and the
    // body so we produce `f(x);` rather than `f(x) ;`.
    let strippedStart = body.range().start.index;
    while (strippedStart > 0 && /\s/.test(source[strippedStart - 1]!)) {
      strippedStart--;
    }
    edits.push({
      start: strippedStart,
      end: body.range().end.index,
      replacement: ';',
    });
    bodiesStripped++;
  }

  // Apply edits end-to-start so earlier ranges stay valid as we rewrite.
  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  return { source: result, bodiesStripped };
}
