/**
 * Rule: chain-assignment
 *
 * Combine `a = x; b = x;` into `a = b = x;` when two adjacent assignments
 * share the same right-hand side.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { extractSimpleAssignment, findAllByKind, findTargetFunction, getStatements, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const chainAssignment: Rule = {
  id: 'chain-assignment',
  description: 'Combine adjacent assignments with identical RHS into a chained assignment.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
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

    // Collect eligible adjacent pairs across all blocks
    const pairs: { first: import('@ast-grep/napi').SgNode; second: import('@ast-grep/napi').SgNode }[] = [];

    for (const block of blocks) {
      const stmts = getStatements(block);
      for (let i = 0; i < stmts.length - 1; i++) {
        const a = stmts[i]!;
        const b = stmts[i + 1]!;

        // Both must be expression_statement containing assignment_expression with '='
        const assignA = extractSimpleAssignment(a);
        const assignB = extractSimpleAssignment(b);

        if (!assignA || !assignB) {
          continue;
        }

        // RHS text must match
        if (assignA.rhsText === assignB.rhsText) {
          pairs.push({ first: a, second: b });
        }
      }
    }

    if (pairs.length === 0) {
      return null;
    }

    const pair = rng.pick(pairs);
    const assignA = extractSimpleAssignment(pair.first)!;
    const assignB = extractSimpleAssignment(pair.second)!;

    // Combine into: `a = b = x;`
    const firstRange = pair.first.range();
    const secondRange = pair.second.range();

    const replacement = `${assignA.lhsText} = ${assignB.lhsText} = ${assignA.rhsText};`;

    // Replace from start of first statement to end of second statement
    return {
      source: replaceRange(source, firstRange.start.index, secondRange.end.index, replacement),
      location: { line: pair.first.range().start.line + 1, column: pair.first.range().start.column + 1 },
    };
  },
};
