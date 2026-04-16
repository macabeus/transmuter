/**
 * Rule: inequality-swap
 *
 * Swap operands and flip comparison operator (e.g., `a < b` becomes `b > a`).
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const FLIP_OPS: Record<string, string> = {
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
};

export const inequalitySwap: Rule = {
  id: 'inequality-swap',
  description: 'Swap operands and flip comparison operator.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    const candidates = findAllByKind(fn, 'binary_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const children = n.children();
      if (children.length < 3) {
        return false;
      }
      const op = children[1]!.text();
      return op in FLIP_OPS;
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

    const children = node.children();
    const op = children[1]!.text();
    const flipped = FLIP_OPS[op]!;

    const range = node.range();
    const replacement = `${right.text()} ${flipped} ${left.text()}`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
