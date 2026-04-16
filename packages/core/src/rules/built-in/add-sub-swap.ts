/**
 * Rule: add-sub-swap
 *
 * Convert `a - b` to `a + (-b)` or vice versa.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const addSubSwap: Rule = {
  id: 'add-sub-swap',
  description: 'Convert between subtraction and addition of negation.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find subtraction candidates: `a - b`
    const subCandidates = findAllByKind(fn, 'binary_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const children = n.children();
      if (children.length < 3) {
        return false;
      }
      return children[1]!.text() === '-';
    });

    // Find addition-of-negation candidates: `a + (-b)`
    const addNegCandidates = findAllByKind(fn, 'binary_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const children = n.children();
      if (children.length < 3) {
        return false;
      }
      if (children[1]!.text() !== '+') {
        return false;
      }

      const right = n.field('right');
      if (!right) {
        return false;
      }

      // Right side should be a parenthesized unary_expression with '-'
      if (right.kind() === 'parenthesized_expression') {
        const inner = right.children().find((c) => c.kind() === 'unary_expression');
        if (!inner) {
          return false;
        }
        return inner.children().some((c) => c.text() === '-');
      }
      // Or a direct unary_expression with '-'
      if (right.kind() === 'unary_expression') {
        return right.children().some((c) => c.text() === '-');
      }
      return false;
    });

    const allCandidates = [
      ...subCandidates.map((n) => ({ kind: 'sub' as const, node: n })),
      ...addNegCandidates.map((n) => ({ kind: 'add-neg' as const, node: n })),
    ];

    if (allCandidates.length === 0) {
      return null;
    }

    const candidate = rng.pick(allCandidates);
    const range = candidate.node.range();

    if (candidate.kind === 'sub') {
      // Convert `a - b` to `a + (-b)`
      const left = candidate.node.field('left');
      const right = candidate.node.field('right');
      if (!left || !right) {
        return null;
      }

      const replacement = `${left.text()} + (-${right.text()})`;
      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: candidate.node.range().start.line + 1, column: candidate.node.range().start.column + 1 },
      };
    } else {
      // Convert `a + (-b)` to `a - b`
      const left = candidate.node.field('left');
      const right = candidate.node.field('right');
      if (!left || !right) {
        return null;
      }

      // Extract the inner expression from the negation
      let innerExpr: import('@ast-grep/napi').SgNode | null = null;

      if (right.kind() === 'parenthesized_expression') {
        const unary = right.children().find((c) => c.kind() === 'unary_expression');
        if (unary) {
          innerExpr = unary.field('argument') ?? null;
        }
      } else if (right.kind() === 'unary_expression') {
        innerExpr = right.field('argument') ?? null;
      }

      if (!innerExpr) {
        return null;
      }

      const replacement = `${left.text()} - ${innerExpr.text()}`;
      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: candidate.node.range().start.line + 1, column: candidate.node.range().start.column + 1 },
      };
    }
  },
};
