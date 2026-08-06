/**
 * Rule: temp-for-expr
 *
 * Extract a random sub-expression into a temporary variable.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, isInsideAsm, replaceRange } from '../helpers.js';
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

    const block = stmt.parent()!;
    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);

    // Generate a unique temp name
    const tempNum = rng.int(0, 999);
    const tempName = `_t${tempNum}`;

    // C89 — every retro profile here (agbcc, old-agbcc, ido, mips-gcc-272) — requires a
    // block's declarations to precede all of its statements. Dropping `int _t = expr;` at
    // an arbitrary statement position is C99, and those compilers reject it, so the temp
    // has to land somewhere legal. Two cases, and both keep evaluation order exactly as it
    // was (hoisting the INITIALISER to the top of the block instead would evaluate the
    // expression early, which is a semantic change when it calls anything):
    //
    //   * a plain statement  → wrap it in a fresh block, whose top the declaration owns;
    //   * a declaration      → insert directly before it, but only while every preceding
    //                          sibling is also a declaration (wrapping is not an option
    //                          there: it would scope the declared name out of the rest of
    //                          the block and break every later use).
    const isDecl = stmt.kind() === 'declaration';
    if (isDecl) {
      const siblings = block.children().filter((c) => c.kind() !== '{' && c.kind() !== '}' && c.kind() !== 'comment');
      for (const sib of siblings) {
        if (sib.range().start.index >= stmtRange.start.index) {
          break;
        }
        if (sib.kind() !== 'declaration') {
          return null;
        }
      }
    }

    // Right to left, so earlier indices stay valid.
    let result = replaceRange(source, range.start.index, range.end.index, tempName);
    const opener = isDecl ? `int ${tempName} = ${exprText};\n${indent}` : `{\n${indent}    int ${tempName} = ${exprText};\n${indent}    `;
    result = result.slice(0, stmtRange.start.index) + opener + result.slice(stmtRange.start.index);
    if (!isDecl) {
      const closeAt = stmtRange.end.index + opener.length;
      result = result.slice(0, closeAt) + `\n${indent}}` + result.slice(closeAt);
    }

    return {
      source: result,
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
