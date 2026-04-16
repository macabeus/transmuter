/**
 * Rule: insert-block
 *
 * Wrap a random statement in `do { ... } while(0)` or `if (1) { ... }`.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, getStatements, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const insertBlock: Rule = {
  id: 'insert-block',
  description: 'Wrap a random statement in a no-op block construct.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'insert', 'delete']),

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
    const stmt = rng.pick(stmts);

    const range = stmt.range();
    const indent = getIndentation(source, stmt);
    const stmtText = stmt.text();

    const useDoWhile = rng.chance(0.5);

    let replacement: string;
    if (useDoWhile) {
      replacement = `do {\n` + `${indent}    ${stmtText}\n` + `${indent}} while(0);`;
    } else {
      replacement = `if (1) {\n` + `${indent}    ${stmtText}\n` + `${indent}}`;
    }

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: stmt.range().start.line + 1, column: stmt.range().start.column + 1 },
    };
  },
};
