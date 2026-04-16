/**
 * Rule: pascal-bool-negate
 *
 * Add double negation `not (not (expr))` to a boolean expression,
 * or unwrap an existing `not X` to just `X`.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const pascalBoolNegate: Rule = {
  id: 'pascal-bool-negate',
  description: 'Add or remove double negation on a boolean expression.',
  languages: ['pascal'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    // Find conditions in if and while statements
    const ifNodes = findAllByKind(fn, 'if');
    const whileNodes = findAllByKind(fn, 'while');

    // Collect condition expressions
    const conditions: { node: ReturnType<typeof fn.find>; isNot: boolean }[] = [];

    for (const node of [...ifNodes, ...whileNodes]) {
      // Find exprUnary with `not` directly in the condition
      const unaryExprs = findAllByKind(node, 'exprUnary').filter((n) => {
        const children = n.children();
        return children.length >= 2 && children[0]!.text().toLowerCase() === 'not';
      });

      for (const expr of unaryExprs) {
        conditions.push({ node: expr, isNot: true });
      }

      // Find exprBinary in conditions (for wrapping with double negation)
      const binaryExprs = findAllByKind(node, 'exprBinary');
      for (const expr of binaryExprs) {
        // Skip if parent is already a unary not
        const parent = expr.parent();
        if (parent && parent.kind() === 'exprUnary') {
          continue;
        }
        conditions.push({ node: expr, isNot: false });
      }
    }

    if (conditions.length === 0) {
      return null;
    }

    const picked = rng.pick(conditions);
    const node = picked.node!;
    const range = node.range();

    let replacement: string;
    if (picked.isNot) {
      // Unwrap: `not X` -> `X`
      const children = node.children();
      const operand = children[children.length - 1]!;
      replacement = operand.text();
    } else {
      // Wrap: `expr` -> `not (not (expr))`
      replacement = `not (not (${node.text()}))`;
    }

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: range.start.line + 1, column: range.start.column + 1 },
    };
  },
};
