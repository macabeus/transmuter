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

    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);

    // Generate a unique temp name
    const tempNum = rng.int(0, 999);
    const tempName = `_t${tempNum}`;

    // Build the temp declaration
    const tempDecl = `int ${tempName} = ${exprText};\n${indent}`;

    // Insert declaration before the statement and replace the expression with the temp name
    // We need to do both edits carefully: insert before statement, replace expression
    // Since the expression is inside the statement, we handle insertion first
    let result = source.slice(0, stmtRange.start.index) + tempDecl + source.slice(stmtRange.start.index);

    // The insertion shifted the expression's position by the length of tempDecl
    const shift = tempDecl.length;
    const newExprStart = range.start.index + shift;
    const newExprEnd = range.end.index + shift;

    result = replaceRange(result, newExprStart, newExprEnd, tempName);

    return {
      source: result,
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
