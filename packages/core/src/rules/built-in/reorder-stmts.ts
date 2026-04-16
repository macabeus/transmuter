/**
 * Rule: reorder-stmts
 *
 * Swap two adjacent statements within a compound block in the target function.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getStatements, swapRanges } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const reorderStmts: Rule = {
  id: 'reorder-stmts',
  description: 'Swap two adjacent statements within a compound block.',
  languages: ['c', 'cpp'],
  defaultWeight: 30,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all compound_statement blocks inside the function
    const blocks = findAllByKind(fn, 'compound_statement');
    if (blocks.length === 0) {
      return null;
    }

    // Collect blocks that have at least 2 statements
    const eligibleBlocks = blocks.filter((block) => getStatements(block).length >= 2);
    if (eligibleBlocks.length === 0) {
      return null;
    }

    const block = rng.pick(eligibleBlocks);
    const stmts = getStatements(block);

    // Pick a random adjacent pair
    const idx = rng.int(0, stmts.length - 2);
    const a = stmts[idx]!;
    const b = stmts[idx + 1]!;

    const aRange = a.range();
    const bRange = b.range();

    return {
      source: swapRanges(source, aRange.start.index, aRange.end.index, bRange.start.index, bRange.end.index),
      location: { line: a.range().start.line + 1, column: a.range().start.column + 1 },
    };
  },
};
