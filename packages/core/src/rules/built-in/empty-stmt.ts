/**
 * Rule: empty-stmt
 *
 * Insert an empty statement `;` at a random position in a compound block.
 * Empty statements can affect compiler optimisation decisions in subtle ways.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, getStatements, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const emptyStmt: Rule = {
  id: 'empty-stmt',
  description: 'Insert an empty statement at a random position in a block.',
  languages: ['c', 'cpp'],
  defaultWeight: 3,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete']),

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

    // Collect blocks that have at least 1 statement
    const eligibleBlocks = blocks.filter((block) => getStatements(block).length >= 1);
    if (eligibleBlocks.length === 0) {
      return null;
    }

    const block = rng.pick(eligibleBlocks);
    const stmts = getStatements(block);

    // Pick a random statement to insert the empty statement after
    const stmt = rng.pick(stmts);
    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);

    const emptyStmt = `\n${indent};`;

    // Insert after the chosen statement
    return {
      source: replaceRange(source, stmtRange.end.index, stmtRange.end.index, emptyStmt),
      location: { line: stmt.range().start.line + 1, column: stmt.range().start.column + 1 },
    };
  },
};
