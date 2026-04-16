/**
 * Rule: pascal-extra-parens
 *
 * Add redundant parentheses around a binary expression.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const pascalExtraParens: Rule = {
  id: 'pascal-extra-parens',
  description: 'Add extra parentheses around a binary expression.',
  languages: ['pascal'],
  defaultWeight: 5,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const candidates = findAllByKind(fn, 'exprBinary').filter((n) => {
      const parent = n.parent();
      if (!parent) {
        return false;
      }
      // Skip if already inside exprParens
      if (parent.kind() === 'exprParens') {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const range = node.range();
    const replacement = `(${node.text()})`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: range.start.line + 1, column: range.start.column + 1 },
    };
  },
};
