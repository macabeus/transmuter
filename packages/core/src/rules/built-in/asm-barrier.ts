/**
 * Rule: asm-barrier
 *
 * Insert `asm("" : "+r"(var));` after a variable assignment to act as an
 * optimisation barrier / register allocation hint.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const asmBarrier: Rule = {
  id: 'asm-barrier',
  description: 'Insert an inline asm barrier after a variable assignment.',
  languages: ['c'],
  defaultWeight: 15,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find expression_statement nodes that contain an assignment_expression
    const exprStmts = findAllByKind(fn, 'expression_statement');
    const candidates = exprStmts.filter((stmt) => {
      if (isInsideAsm(stmt)) {
        return false;
      }
      const assignment = stmt.find({ rule: { kind: 'assignment_expression' } });
      if (!assignment) {
        return false;
      }
      // Extract the left-hand side — must be a simple identifier
      const left = assignment.field('left');
      if (!left) {
        return false;
      }
      return left.kind() === 'identifier';
    });

    if (candidates.length === 0) {
      return null;
    }

    const stmt = rng.pick(candidates);
    const assignment = stmt.find({ rule: { kind: 'assignment_expression' } })!;
    const varName = assignment.field('left')!.text();

    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);

    const barrier = `\n${indent}asm("" : "+r"(${varName}));`;

    // Insert the asm barrier immediately after the assignment statement
    return {
      source: replaceRange(source, stmtRange.end.index, stmtRange.end.index, barrier),
      location: { line: stmt.range().start.line + 1, column: stmt.range().start.column + 1 },
    };
  },
};
