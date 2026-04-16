/**
 * Rule: pascal-arith-shift
 *
 * Convert between multiplication/division by power-of-2 and shl/shr calls:
 *   `x * 2` <-> `shl(x, 1)`
 *   `x div 2` <-> `shr(x, 1)`
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';
import { isPowerOf2, log2 } from '~/utils/math.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

interface ShiftCandidate {
  node: SgNode;
  kind: 'mult-to-shl' | 'div-to-shr' | 'shl-to-mult' | 'shr-to-div';
}

export const pascalArithShift: Rule = {
  id: 'pascal-arith-shift',
  description: 'Convert between multiplication/division by power-of-2 and shl/shr.',
  languages: ['pascal'],
  defaultWeight: 15,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const candidates: ShiftCandidate[] = [];

    // Find `x * N` or `x div N` where N is a power of 2
    const binaryExprs = findAllByKind(fn, 'exprBinary');
    for (const n of binaryExprs) {
      const children = n.children();
      if (children.length < 3) {
        continue;
      }
      const op = children[1]!.text();
      // In exprBinary, children are: [left, operator, right]
      const right = children[2];

      if (!right || right.kind() !== 'literalNumber') {
        continue;
      }

      const val = parseInt(right.text(), 10);
      if (isNaN(val) || val < 2 || !isPowerOf2(val)) {
        continue;
      }

      if (op === '*') {
        candidates.push({ node: n, kind: 'mult-to-shl' });
      } else if (op.toLowerCase() === 'div') {
        candidates.push({ node: n, kind: 'div-to-shr' });
      }
    }

    // Find shl(x, N) or shr(x, N) call expressions
    const callExprs = findAllByKind(fn, 'exprCall');
    for (const n of callExprs) {
      const funcNode = n.children()[0];
      if (!funcNode || funcNode.kind() !== 'identifier') {
        continue;
      }
      const name = funcNode.text().toLowerCase();
      if (name === 'shl') {
        candidates.push({ node: n, kind: 'shl-to-mult' });
      } else if (name === 'shr') {
        candidates.push({ node: n, kind: 'shr-to-div' });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const picked = rng.pick(candidates);
    const node = picked.node;
    const range = node.range();

    let replacement: string;
    if (picked.kind === 'mult-to-shl') {
      // In exprBinary, children are: [left, operator, right]
      const children = node.children();
      const left = children[0]!;
      const right = children[2]!;
      const shift = log2(parseInt(right.text(), 10));
      replacement = `shl(${left.text()}, ${shift})`;
    } else if (picked.kind === 'div-to-shr') {
      // In exprBinary, children are: [left, operator, right]
      const children = node.children();
      const left = children[0]!;
      const right = children[2]!;
      const shift = log2(parseInt(right.text(), 10));
      replacement = `shr(${left.text()}, ${shift})`;
    } else {
      // shl-to-mult or shr-to-div: extract arguments from exprArgs child
      const exprArgs = node.children().find((c) => c.kind() === 'exprArgs');
      const args = exprArgs ? exprArgs.children().filter((c) => c.kind() !== ',') : [];
      if (args.length < 2) {
        return null;
      }
      const base = args[0]!.text();
      const shiftVal = parseInt(args[1]!.text(), 10);
      if (isNaN(shiftVal) || shiftVal < 0 || shiftVal > 5) {
        return null;
      }
      const multiplier = 1 << shiftVal;
      if (picked.kind === 'shl-to-mult') {
        replacement = `${base} * ${multiplier}`;
      } else {
        replacement = `${base} div ${multiplier}`;
      }
    }

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: range.start.line + 1, column: range.start.column + 1 },
    };
  },
};
