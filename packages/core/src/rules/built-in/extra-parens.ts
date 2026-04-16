/**
 * Rule: extra-parens
 *
 * Add extra parentheses around an expression: `expr` -> `(expr)`.
 * Extra parentheses can affect code generation by changing how the
 * compiler groups sub-expressions internally.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const extraParens: Rule = {
  id: 'extra-parens',
  description: 'Add extra parentheses around an expression.',
  languages: ['c', 'cpp'],
  defaultWeight: 3,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find binary_expression, conditional_expression, and assignment_expression nodes
    const binaryExprs = findAllByKind(fn, 'binary_expression');
    const conditionalExprs = findAllByKind(fn, 'conditional_expression');
    const assignmentExprs = findAllByKind(fn, 'assignment_expression');
    const candidates = [...binaryExprs, ...conditionalExprs, ...assignmentExprs].filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const parent = n.parent();
      if (!parent) {
        return false;
      }
      // Skip if already directly inside a parenthesized_expression
      if (parent.kind() === 'parenthesized_expression') {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const range = node.range();
    const exprText = node.text();

    const replacement = `(${exprText})`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
