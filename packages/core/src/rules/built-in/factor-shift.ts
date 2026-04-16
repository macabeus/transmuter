/**
 * Rule: factor-shift
 *
 * Convert between shifts and multiplication:
 *   `a << N` <-> `a * (1 << N)` (e.g., `a << 2` <-> `a * 4`)
 *
 * Also handles the reverse: `a * N` where N is a power of 2
 * becomes `a << log2(N)`.
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';
import { isPowerOf2, log2 } from '~/utils/math.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

interface ShiftCandidate {
  node: SgNode;
  kind: 'shift-to-mult' | 'mult-to-shift';
}

export const factorShift: Rule = {
  id: 'factor-shift',
  description: 'Convert between shift and multiplication (a << N <-> a * 2^N).',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    const candidates: ShiftCandidate[] = [];

    // Find `a << N` where N is a small number literal (0-5)
    const binaryExprs = findAllByKind(fn, 'binary_expression');
    for (const n of binaryExprs) {
      if (isInsideAsm(n)) {
        continue;
      }

      const children = n.children();

      // Check for left shift
      const shiftOp = children.find((c) => c.text() === '<<');
      if (shiftOp) {
        const right = n.field('right');
        if (right && right.kind() === 'number_literal') {
          const val = parseInt(right.text(), 10);
          if (!isNaN(val) && val >= 0 && val <= 5) {
            candidates.push({ node: n, kind: 'shift-to-mult' });
          }
        }
        continue;
      }

      // Check for multiplication by a power of 2
      const multOp = children.find((c) => c.text() === '*');
      if (multOp) {
        const right = n.field('right');
        if (right && right.kind() === 'number_literal') {
          const val = parseInt(right.text(), 10);
          if (!isNaN(val) && val >= 2 && isPowerOf2(val)) {
            candidates.push({ node: n, kind: 'mult-to-shift' });
          }
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const picked = rng.pick(candidates);
    const node = picked.node;
    const left = node.field('left');
    const right = node.field('right');
    if (!left || !right) {
      return null;
    }

    const leftText = left.text();
    const val = parseInt(right.text(), 10);
    const range = node.range();

    let replacement: string;
    if (picked.kind === 'shift-to-mult') {
      // a << N  ->  a * (1 << N)
      replacement = `(${leftText} * ${1 << val})`;
    } else {
      // a * N  ->  a << log2(N)
      replacement = `(${leftText} << ${log2(val)})`;
    }

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
