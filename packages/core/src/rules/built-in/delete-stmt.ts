/**
 * Rule: delete-stmt
 *
 * Removes a random statement from a compound block in the target function.
 * Only deletes: expression_statement, if_statement, while_statement,
 * for_statement, do_statement, switch_statement.
 * Skips declarations and return statements.
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getStatements, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const DELETABLE_KINDS = new Set([
  'expression_statement',
  'if_statement',
  'while_statement',
  'for_statement',
  'do_statement',
  'switch_statement',
]);

export const deleteStmt: Rule = {
  id: 'delete-stmt',
  description: 'Remove a random statement from a compound block.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
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

    // Collect all deletable statements across all blocks
    const candidates: SgNode[] = [];
    for (const block of blocks) {
      const stmts = getStatements(block);
      for (const stmt of stmts) {
        if (DELETABLE_KINDS.has(stmt.kind() as string)) {
          candidates.push(stmt);
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const stmt = rng.pick(candidates);
    const range = stmt.range();

    // Determine the end index: consume any trailing newline
    let endIndex = range.end.index;
    if (endIndex < source.length && source[endIndex] === '\n') {
      endIndex++;
    }

    // Determine the start index: consume leading whitespace on the line
    let startIndex = range.start.index;
    while (startIndex > 0 && source[startIndex - 1] !== '\n' && /\s/.test(source[startIndex - 1]!)) {
      startIndex--;
    }

    return {
      source: replaceRange(source, startIndex, endIndex, ''),
      location: { line: range.start.line + 1, column: range.start.column + 1 },
    };
  },
};
