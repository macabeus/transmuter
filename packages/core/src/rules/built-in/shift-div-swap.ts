/**
 * Rule: shift-div-swap
 *
 * Convert between right-shift and division by power of 2:
 *   `x >> N` <-> `x / (1 << N)` (e.g., `x >> 8` <-> `x / 256`)
 *   `x >>= N` <-> `x /= (1 << N)` (compound assignment form)
 *
 * Only applies for number literals where N is 1-31.
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';
import { isPowerOf2, log2 } from '~/utils/math.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

interface Candidate {
  node: SgNode;
  kind: 'shift-to-div' | 'div-to-shift';
  form: 'binary' | 'assignment';
}

export const shiftDivSwap: Rule = {
  id: 'shift-div-swap',
  description: 'Convert between right-shift and division by power of 2 (x >> N <-> x / 2^N).',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    const candidates: Candidate[] = [];

    // --- binary_expression candidates ---
    const binaryExprs = findAllByKind(fn, 'binary_expression');
    for (const n of binaryExprs) {
      if (isInsideAsm(n)) {
        continue;
      }

      const children = n.children();

      // Check for right shift: x >> N
      const shiftOp = children.find((c) => c.text() === '>>');
      if (shiftOp) {
        const right = n.field('right');
        if (right && right.kind() === 'number_literal') {
          const val = parseInt(right.text(), 10);
          if (!isNaN(val) && val >= 1 && val <= 31) {
            candidates.push({ node: n, kind: 'shift-to-div', form: 'binary' });
          }
        }
        continue;
      }

      // Check for division by power of 2: x / N
      const divOp = children.find((c) => c.text() === '/');
      if (divOp) {
        const right = n.field('right');
        if (right && right.kind() === 'number_literal') {
          const val = parseInt(right.text(), 10);
          if (!isNaN(val) && val >= 2 && isPowerOf2(val)) {
            const shift = log2(val);
            if (shift >= 1 && shift <= 31) {
              candidates.push({ node: n, kind: 'div-to-shift', form: 'binary' });
            }
          }
        }
      }
    }

    // --- assignment_expression candidates ---
    const assignExprs = findAllByKind(fn, 'assignment_expression');
    for (const n of assignExprs) {
      if (isInsideAsm(n)) {
        continue;
      }

      const children = n.children();

      // Check for >>= N
      const shiftAssignOp = children.find((c) => c.text() === '>>=');
      if (shiftAssignOp) {
        const right = n.field('right');
        if (right && right.kind() === 'number_literal') {
          const val = parseInt(right.text(), 10);
          if (!isNaN(val) && val >= 1 && val <= 31) {
            candidates.push({ node: n, kind: 'shift-to-div', form: 'assignment' });
          }
        }
        continue;
      }

      // Check for /= N where N is a power of 2
      const divAssignOp = children.find((c) => c.text() === '/=');
      if (divAssignOp) {
        const right = n.field('right');
        if (right && right.kind() === 'number_literal') {
          const val = parseInt(right.text(), 10);
          if (!isNaN(val) && val >= 2 && isPowerOf2(val)) {
            const shift = log2(val);
            if (shift >= 1 && shift <= 31) {
              candidates.push({ node: n, kind: 'div-to-shift', form: 'assignment' });
            }
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
    if (picked.kind === 'shift-to-div') {
      // >> N  ->  / (1 << N)   or   >>= N  ->  /= (1 << N)
      const divVal = 1 << val;
      if (picked.form === 'binary') {
        replacement = `${leftText} / ${divVal}`;
      } else {
        replacement = `${leftText} /= ${divVal}`;
      }
    } else {
      // / N  ->  >> log2(N)   or   /= N  ->  >>= log2(N)
      const shift = log2(val);
      if (picked.form === 'binary') {
        replacement = `${leftText} >> ${shift}`;
      } else {
        replacement = `${leftText} >>= ${shift}`;
      }
    }

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: range.start.line + 1, column: range.start.column + 1 },
    };
  },
};
