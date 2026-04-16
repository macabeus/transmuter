/**
 * Rule: reorder-decls
 *
 * Swap two adjacent variable declarations at the top of a block.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getDeclarations, swapRanges } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const reorderDecls: Rule = {
  id: 'reorder-decls',
  description: 'Swap two adjacent variable declarations at the top of a block.',
  languages: ['c', 'cpp'],
  defaultWeight: 20,
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

    // Collect blocks that have at least 2 declarations
    const eligibleBlocks = blocks.filter((block) => getDeclarations(block).length >= 2);
    if (eligibleBlocks.length === 0) {
      return null;
    }

    const block = rng.pick(eligibleBlocks);
    const decls = getDeclarations(block);

    // Pick a random adjacent pair
    const idx = rng.int(0, decls.length - 2);
    const a = decls[idx]!;
    const b = decls[idx + 1]!;

    const aRange = a.range();
    const bRange = b.range();

    return {
      source: swapRanges(source, aRange.start.index, aRange.end.index, bRange.start.index, bRange.end.index),
      location: { line: a.range().start.line + 1, column: a.range().start.column + 1 },
    };
  },
};
