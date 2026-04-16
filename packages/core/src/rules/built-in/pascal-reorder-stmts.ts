/**
 * Rule: pascal-reorder-stmts
 *
 * Swap two adjacent statements within a Pascal begin/end block.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, swapRanges } from '../helpers.js';
import { getPascalStatements } from '../pascal-helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const pascalReorderStmts: Rule = {
  id: 'pascal-reorder-stmts',
  description: 'Swap two adjacent statements within a Pascal begin/end block.',
  languages: ['pascal'],
  defaultWeight: 30,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const blocks = findAllByKind(fn, 'block');
    if (blocks.length === 0) {
      return null;
    }

    const eligibleBlocks = blocks.filter((block) => getPascalStatements(block).length >= 2);
    if (eligibleBlocks.length === 0) {
      return null;
    }

    const block = rng.pick(eligibleBlocks);
    const stmts = getPascalStatements(block);

    const idx = rng.int(0, stmts.length - 2);
    const a = stmts[idx]!;
    const b = stmts[idx + 1]!;

    const aRange = a.range();
    const bRange = b.range();

    return {
      source: swapRanges(source, aRange.start.index, aRange.end.index, bRange.start.index, bRange.end.index),
      location: { line: aRange.start.line + 1, column: aRange.start.column + 1 },
    };
  },
};
