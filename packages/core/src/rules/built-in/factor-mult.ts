/**
 * Rule: factor-mult
 *
 * Factor or unfactor multiplication expressions.
 * Finds `a * N` where N is a number literal > 1 and expands it
 * to `a * (N-1) + a` or `a * (N+1) - a`.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const factorMult: Rule = {
  id: 'factor-mult',
  description: 'Expand a * N into a * (N-1) + a or a * (N+1) - a.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find binary_expression with '*' operator where right side is a number > 1
    const candidates = findAllByKind(fn, 'binary_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }

      const children = n.children();
      const opNode = children.find((c) => c.text() === '*');
      if (!opNode) {
        return false;
      }

      const right = n.field('right');
      if (!right || right.kind() !== 'number_literal') {
        return false;
      }

      const val = parseInt(right.text(), 10);
      return !isNaN(val) && val > 1;
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
    const val = parseInt(right.text(), 10);
    const range = node.range();

    // Randomly choose between `a * (N-1) + a` and `a * (N+1) - a`
    let replacement: string;
    if (rng.chance(0.5)) {
      replacement = `(${leftText} * ${val - 1} + ${leftText})`;
    } else {
      replacement = `(${leftText} * ${val + 1} - ${leftText})`;
    }

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
