/**
 * Rule: duplicate-assignment
 *
 * Duplicate an assignment statement (insert a copy right after itself).
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const duplicateAssignment: Rule = {
  id: 'duplicate-assignment',
  description: 'Duplicate an assignment statement by inserting a copy right after it.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find expression_statement nodes containing assignment_expression
    const exprStmts = findAllByKind(fn, 'expression_statement');
    const candidates = exprStmts.filter((stmt) => {
      if (isInsideAsm(stmt)) {
        return false;
      }
      const assign = stmt.find({ rule: { kind: 'assignment_expression' } });
      return assign !== null;
    });

    if (candidates.length === 0) {
      return null;
    }

    const stmt = rng.pick(candidates);
    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);
    const stmtText = stmt.text();

    // Insert a duplicate right after the statement
    const duplicate = `\n${indent}${stmtText}`;

    return {
      source: replaceRange(source, stmtRange.end.index, stmtRange.end.index, duplicate),
      location: { line: stmt.range().start.line + 1, column: stmt.range().start.column + 1 },
    };
  },
};
