/**
 * Rule: xor-zero
 *
 * Add `^ 0` or `^ 0u` to a random expression: `expr` becomes `(expr ^ 0)`.
 * XOR with zero is a no-op but can perturb register allocation.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const xorZero: Rule = {
  id: 'xor-zero',
  description: 'Add ^ 0 to a random expression.',
  languages: ['c', 'cpp'],
  defaultWeight: 3,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find identifier nodes in expression contexts
    const identifiers = findAllByKind(fn, 'identifier').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const parent = n.parent();
      if (!parent) {
        return false;
      }

      // Skip identifiers that are function names in call expressions
      if (parent.kind() === 'call_expression' && isSameNode(parent.field('function'), n)) {
        return false;
      }
      // Skip identifiers that are declaration names
      if (parent.kind() === 'declaration') {
        return false;
      }
      if (parent.kind() === 'init_declarator' && isSameNode(parent.field('declarator'), n)) {
        return false;
      }
      // Skip identifiers that are type specifiers
      if (parent.kind() === 'type_identifier' || parent.kind() === 'sized_type_specifier') {
        return false;
      }
      // Skip identifiers used as field names in field_expression (after the '.')
      if (parent.kind() === 'field_expression' && isSameNode(parent.field('field'), n)) {
        return false;
      }
      // Skip function parameter declarators
      if (parent.kind() === 'parameter_declaration') {
        return false;
      }
      // Must be in an expression context
      const parentKind = parent.kind();
      return (
        parentKind === 'assignment_expression' ||
        parentKind === 'binary_expression' ||
        parentKind === 'unary_expression' ||
        parentKind === 'argument_list' ||
        parentKind === 'expression_statement' ||
        parentKind === 'parenthesized_expression' ||
        parentKind === 'return_statement' ||
        parentKind === 'init_declarator' ||
        parentKind === 'field_expression' ||
        parentKind === 'subscript_expression' ||
        parentKind === 'conditional_expression' ||
        parentKind === 'cast_expression' ||
        parentKind === 'comma_expression'
      );
    });

    if (identifiers.length === 0) {
      return null;
    }

    const node = rng.pick(identifiers);
    const range = node.range();
    const exprText = node.text();

    // Randomly choose between `^ 0` and `^ 0u`
    const suffix = rng.chance(0.5) ? '0' : '0u';
    const replacement = `(${exprText} ^ ${suffix})`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
