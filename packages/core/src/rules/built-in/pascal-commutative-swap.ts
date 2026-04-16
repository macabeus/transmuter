/**
 * Rule: pascal-commutative-swap
 *
 * Reorder operands of a commutative binary operation in Pascal.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, swapRanges } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const COMMUTATIVE_OPS = new Set(['+', '*', '=', '<>']);

export const pascalCommutativeSwap: Rule = {
  id: 'pascal-commutative-swap',
  description: 'Reorder operands of a commutative binary operation in Pascal.',
  languages: ['pascal'],
  defaultWeight: 15,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const candidates = findAllByKind(fn, 'exprBinary').filter((n) => {
      const children = n.children();
      if (children.length < 3) {
        return false;
      }
      const op = children[1]!.text();
      return COMMUTATIVE_OPS.has(op);
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const children = node.children();
    // In exprBinary, children are: [left, operator, right]
    const left = children[0];
    const right = children[2];

    if (!left || !right) {
      return null;
    }

    if (left.text() === right.text()) {
      return null;
    }

    const leftRange = left.range();
    const rightRange = right.range();

    return {
      source: swapRanges(
        source,
        leftRange.start.index,
        leftRange.end.index,
        rightRange.start.index,
        rightRange.end.index,
      ),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
