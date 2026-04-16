/**
 * Rule: struct-ref-swap
 *
 * Convert between `a->b` and `(*a).b` forms.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const structRefSwap: Rule = {
  id: 'struct-ref-swap',
  description: 'Convert between arrow and dereference-dot member access.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find `a->b` candidates (field_expression with -> operator)
    const arrowCandidates = findAllByKind(fn, 'field_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      return n.children().some((c) => c.text() === '->');
    });

    // Find `(*a).b` candidates (field_expression with '.' where argument is parenthesized
    // pointer_expression)
    const derefDotCandidates = findAllByKind(fn, 'field_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const children = n.children();
      // Must use '.' operator
      if (!children.some((c) => c.text() === '.')) {
        return false;
      }

      const arg = n.field('argument');
      if (!arg) {
        return false;
      }

      // The argument should be a parenthesized_expression containing a pointer_expression
      if (arg.kind() === 'parenthesized_expression') {
        const inner = arg.children().find((c) => c.kind() === 'pointer_expression');
        return inner !== undefined;
      }
      return false;
    });

    const allCandidates = [
      ...arrowCandidates.map((n) => ({ kind: 'arrow' as const, node: n })),
      ...derefDotCandidates.map((n) => ({ kind: 'deref-dot' as const, node: n })),
    ];

    if (allCandidates.length === 0) {
      return null;
    }

    const candidate = rng.pick(allCandidates);
    const range = candidate.node.range();

    if (candidate.kind === 'arrow') {
      // Convert `a->b` to `(*a).b`
      const arg = candidate.node.field('argument');
      const field = candidate.node.field('field');
      if (!arg || !field) {
        return null;
      }

      const replacement = `(*${arg.text()}).${field.text()}`;
      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: candidate.node.range().start.line + 1, column: candidate.node.range().start.column + 1 },
      };
    } else {
      // Convert `(*a).b` to `a->b`
      const arg = candidate.node.field('argument');
      const field = candidate.node.field('field');
      if (!arg || !field) {
        return null;
      }

      // arg is a parenthesized_expression containing a pointer_expression
      const ptrExpr = arg.children().find((c) => c.kind() === 'pointer_expression');
      if (!ptrExpr) {
        return null;
      }

      // pointer_expression's operand is the actual pointer
      const operand = ptrExpr.field('argument');
      if (!operand) {
        return null;
      }

      const replacement = `${operand.text()}->${field.text()}`;
      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: candidate.node.range().start.line + 1, column: candidate.node.range().start.column + 1 },
      };
    }
  },
};
