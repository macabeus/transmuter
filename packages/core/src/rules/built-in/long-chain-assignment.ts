/**
 * Rule: long-chain-assignment
 *
 * Chain 3+ consecutive assignments with the same RHS into one statement.
 * For example: `a = x; b = x; c = x;` becomes `a = b = c = x;`
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';

import {
  type SimpleAssignment,
  extractSimpleAssignment,
  findAllByKind,
  findTargetFunction,
  getIndentation,
  getStatements,
  replaceRange,
} from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const longChainAssignment: Rule = {
  id: 'long-chain-assignment',
  description: 'Chain 3+ consecutive assignments with identical RHS into one statement.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all compound_statement blocks
    const blocks = findAllByKind(fn, 'compound_statement');
    if (blocks.length === 0) {
      return null;
    }

    // Collect runs of 3+ adjacent assignments with identical RHS
    const runs: { stmts: SgNode[]; assignments: SimpleAssignment[] }[] = [];

    for (const block of blocks) {
      const stmts = getStatements(block);

      let runStart = 0;
      while (runStart < stmts.length) {
        const firstAssign = extractSimpleAssignment(stmts[runStart]!);
        if (!firstAssign) {
          runStart++;
          continue;
        }

        // Try to extend the run
        const runStmts: SgNode[] = [stmts[runStart]!];
        const runAssigns: SimpleAssignment[] = [firstAssign];

        let j = runStart + 1;
        while (j < stmts.length) {
          const assign = extractSimpleAssignment(stmts[j]!);
          if (!assign || assign.rhsText !== firstAssign.rhsText) {
            break;
          }
          runStmts.push(stmts[j]!);
          runAssigns.push(assign);
          j++;
        }

        if (runStmts.length >= 3) {
          runs.push({ stmts: runStmts, assignments: runAssigns });
        }

        runStart = j;
      }
    }

    if (runs.length === 0) {
      return null;
    }

    const run = rng.pick(runs);
    const firstStmt = run.stmts[0]!;
    const lastStmt = run.stmts[run.stmts.length - 1]!;
    const indent = getIndentation(source, firstStmt);

    // Build the chained assignment: `a = b = c = x;`
    const lhsParts = run.assignments.map((a) => a.lhsText);
    const rhsText = run.assignments[0]!.rhsText;
    const chained = `${indent}${lhsParts.join(' = ')} = ${rhsText};`;

    return {
      source: replaceRange(source, firstStmt.range().start.index, lastStmt.range().end.index, chained),
      location: { line: firstStmt.range().start.line + 1, column: firstStmt.range().start.column + 1 },
    };
  },
};
