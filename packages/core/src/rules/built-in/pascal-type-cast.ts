/**
 * Rule: pascal-type-cast
 *
 * Add or remove function-style type casts:
 *   ADD: `x` -> `integer(x)`
 *   REMOVE: `integer(x)` -> `x`
 *
 * Recognized cast types: integer, char, boolean, word, byte, longint.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const CAST_TYPES = new Set(['integer', 'char', 'boolean', 'word', 'byte', 'longint']);

export const pascalTypeCast: Rule = {
  id: 'pascal-type-cast',
  description: 'Add or remove a function-style type cast.',
  languages: ['pascal'],
  defaultWeight: 15,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const direction = rng.pick(['add', 'remove'] as const);

    if (direction === 'remove') {
      // Find call nodes where the function name matches a cast type
      const candidates = findAllByKind(fn, 'exprCall').filter((n) => {
        const funcNode = n.children()[0];
        if (!funcNode || funcNode.kind() !== 'identifier') {
          return false;
        }
        return CAST_TYPES.has(funcNode.text().toLowerCase());
      });

      if (candidates.length === 0) {
        return null;
      }

      const node = rng.pick(candidates);
      // Extract arguments from exprArgs child of exprCall
      const exprArgs = node.children().find((c) => c.kind() === 'exprArgs');
      const args = exprArgs ? exprArgs.children().filter((c) => c.kind() !== ',') : [];
      if (args.length === 0) {
        return null;
      }

      const range = node.range();
      const replacement = args[0]!.text();

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    } else {
      // Add a type cast around a random identifier
      const candidates = findAllByKind(fn, 'identifier').filter((n) => {
        const parent = n.parent();
        if (!parent) {
          return false;
        }
        // Skip if already the function name in a call node
        if (parent.kind() === 'exprCall' && parent.children()[0] === n) {
          return false;
        }
        // Skip type names in declarations
        if (parent.kind() === 'declVar') {
          return false;
        }
        // Skip the function/procedure name itself
        if (parent.kind() === 'defProc' || parent.kind() === 'declProc') {
          return false;
        }
        return true;
      });

      if (candidates.length === 0) {
        return null;
      }

      const node = rng.pick(candidates);
      const castType = rng.pick([...CAST_TYPES]);
      const range = node.range();
      const replacement = `${castType}(${node.text()})`;

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    }
  },
};
