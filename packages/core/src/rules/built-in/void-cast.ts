/**
 * Rule: void-cast
 *
 * Wrap a standalone function call statement with `(void)` cast.
 * For example: `foo();` becomes `(void)foo();`
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const voidCast: Rule = {
  id: 'void-cast',
  description: 'Add a (void) cast to a standalone function call statement.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find expression_statement nodes whose direct expression is a call_expression
    const exprStmts = findAllByKind(fn, 'expression_statement');
    const candidates = exprStmts.filter((stmt) => {
      if (isInsideAsm(stmt)) {
        return false;
      }
      const children = stmt.children();
      // The first non-semicolon child should be a call_expression
      const expr = children.find((c) => c.kind() !== ';');
      if (!expr || expr.kind() !== 'call_expression') {
        return false;
      }
      // Skip if already wrapped in a cast_expression
      if (children.find((c) => c.kind() === 'cast_expression')) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    const stmt = rng.pick(candidates);
    const children = stmt.children();
    const callExpr = children.find((c) => c.kind() === 'call_expression')!;
    const callRange = callExpr.range();

    const replacement = `(void)${callExpr.text()}`;

    return {
      source: replaceRange(source, callRange.start.index, callRange.end.index, replacement),
      location: { line: callExpr.range().start.line + 1, column: callExpr.range().start.column + 1 },
    };
  },
};
