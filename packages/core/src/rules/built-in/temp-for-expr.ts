/**
 * Rule: temp-for-expr
 *
 * Extract a random sub-expression into a temporary variable.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import {
  findAllByKind,
  findTargetFunction,
  getIndentation,
  getStatements,
  isInsideAsm,
  replaceRange,
} from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const tempForExpr: Rule = {
  id: 'temp-for-expr',
  description: 'Extract a random sub-expression into a temporary variable.',
  languages: ['c', 'cpp'],
  defaultWeight: 100,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find binary_expression and call_expression nodes inside the function
    const binaryExprs = findAllByKind(fn, 'binary_expression');
    const callExprs = findAllByKind(fn, 'call_expression');
    const candidates = [...binaryExprs, ...callExprs].filter((n) => !isInsideAsm(n));

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const exprText = node.text();
    const range = node.range();

    // Walk up to find the enclosing statement (direct child of a compound_statement)
    let stmt = node;
    while (stmt.parent() && stmt.parent()!.kind() !== 'compound_statement') {
      stmt = stmt.parent()!;
    }
    if (!stmt.parent()) {
      return null;
    }

    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);

    // Generate a unique temp name
    const tempNum = rng.int(0, 999);
    const tempName = `_t${tempNum}`;

    // Every compiler profile this tool ships (agbcc, old-agbcc, ido, mips-gcc-272) is C89, so a
    // declaration may only appear at the top of a block. Dropping `int _t = …;` in front of an
    // arbitrary statement produces source the compiler REJECTS, and a rejected candidate is not
    // a mutation — it is a wasted slot, or worse, a phantom score where the pipeline keeps going.
    //
    // Two placements keep it legal, and both preserve evaluation order (hoisting the initialiser
    // above intervening statements would not):
    //
    //   * before a `declaration`, but only while nothing except declarations precedes it — that
    //     keeps the whole run inside the block's declaration prefix;
    //   * otherwise wrap the statement in a block of its own, and declare the temp at ITS top.
    const parent = stmt.parent()!;
    const siblings = getStatements(parent);
    const idx = siblings.findIndex((c) => c.range().start.index === stmtRange.start.index);

    let result: string;
    let shift: number;

    if (stmt.kind() === 'declaration') {
      if (idx < 0 || siblings.slice(0, idx).some((c) => c.kind() !== 'declaration')) {
        return null;
      }
      const tempDecl = `int ${tempName} = ${exprText};\n${indent}`;
      result = source.slice(0, stmtRange.start.index) + tempDecl + source.slice(stmtRange.start.index);
      shift = tempDecl.length;
    } else {
      const inner = `${indent}    `;
      const prefix = `{\n${inner}int ${tempName} = ${exprText};\n${inner}`;
      // The statement's own text is copied VERBATIM. Re-indenting its continuation lines would
      // read better and would also change its length, which moves the expression that is about
      // to be replaced by offset — the edit below would then land on the wrong characters.
      const stmtText = source.slice(stmtRange.start.index, stmtRange.end.index);
      result =
        source.slice(0, stmtRange.start.index) + prefix + stmtText + `\n${indent}}` + source.slice(stmtRange.end.index);
      shift = prefix.length;
    }

    // The insertion shifted the expression's position by the length of what went before it
    const newExprStart = range.start.index + shift;
    const newExprEnd = range.end.index + shift;

    result = replaceRange(result, newExprStart, newExprEnd, tempName);

    return {
      source: result,
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
