/**
 * Rule: commutative-swap
 *
 * Reorder operands of commutative binary operations.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const COMMUTATIVE_OPS = new Set(['+', '*', '&', '|', '^', '==', '!=']);

export const commutativeSwap: Rule = {
  id: 'commutative-swap',
  description: 'Reorder operands of a commutative binary operation.',
  languages: ['c', 'cpp'],
  defaultWeight: 15,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all binary_expression nodes with commutative operators
    const candidates = findAllByKind(fn, 'binary_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      // The operator is typically the middle child of a binary_expression
      const children = n.children();
      // binary_expression children: [left, operator, right]
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
    const left = node.field('left');
    const right = node.field('right');

    if (!left || !right) {
      return null;
    }

    const leftText = left.text();
    const rightText = right.text();

    // Don't swap if both sides are identical
    if (leftText === rightText) {
      return null;
    }

    const range = node.range();
    const children = node.children();
    // Reconstruct as: right op left
    const op = children[1]!.text();
    const replacement = `${rightText} ${op} ${leftText}`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
