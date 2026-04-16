/**
 * Rule: sameline
 *
 * Combine two adjacent statements onto the same line by removing the
 * newline between them. This affects IDO codegen where same-lineness matters.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getStatements } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const sameline: Rule = {
  id: 'sameline',
  description: 'Combine two adjacent statements onto the same line.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
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

    // Collect blocks with at least 2 statements
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

    // They must be on different lines — skip if already on the same line
    const aEndLine = a.range().end.line;
    const bStartLine = b.range().start.line;
    if (aEndLine === bStartLine) {
      return null;
    }

    // Remove whitespace/newline between end of first statement and start of second
    const aEndIndex = a.range().end.index;
    const bStartIndex = b.range().start.index;

    // Replace the gap with a single space
    return {
      source: source.slice(0, aEndIndex) + ' ' + source.slice(bStartIndex),
      location: { line: a.range().start.line + 1, column: a.range().start.column + 1 },
    };
  },
};
