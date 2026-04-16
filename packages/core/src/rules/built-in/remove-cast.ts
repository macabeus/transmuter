/**
 * Rule: remove-cast
 *
 * Remove an existing type cast expression, replacing it with the inner expression.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const removeCast: Rule = {
  id: 'remove-cast',
  description: 'Remove an existing type cast expression.',
  languages: ['c', 'cpp'],
  defaultWeight: 20,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all cast_expression nodes
    const casts = findAllByKind(fn, 'cast_expression').filter((n) => !isInsideAsm(n));

    if (casts.length === 0) {
      return null;
    }

    const node = rng.pick(casts);
    const range = node.range();

    // A cast_expression has the form: (type)expression
    // The inner expression is the 'value' field
    const value = node.field('value');
    if (!value) {
      return null;
    }

    const innerText = value.text();

    return {
      source: replaceRange(source, range.start.index, range.end.index, innerText),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
