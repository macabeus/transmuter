/**
 * Rule: mult-zero
 *
 * Add identity operations to expressions: `expr * 1`, `expr + 0`,
 * `expr | 0`, or `expr - 0`. These are algebraic no-ops but can
 * perturb register allocation and instruction scheduling.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const IDENTITY_OPS = [{ op: '* 1' }, { op: '+ 0' }, { op: '| 0' }, { op: '- 0' }] as const;

export const multZero: Rule = {
  id: 'mult-zero',
  description: 'Add an identity operation (* 1, + 0, | 0, - 0) to a random expression.',
  languages: ['c', 'cpp'],
  defaultWeight: 3,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find identifier and number_literal nodes in expression contexts
    const identifiers = findAllByKind(fn, 'identifier');
    const numberLiterals = findAllByKind(fn, 'number_literal');
    const candidates = [...identifiers, ...numberLiterals].filter((n) => {
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
      // Skip type specifiers
      if (parent.kind() === 'type_identifier' || parent.kind() === 'sized_type_specifier') {
        return false;
      }
      // Skip identifiers used as field names in field_expression
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

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const range = node.range();
    const exprText = node.text();

    const identity = rng.pick(IDENTITY_OPS);
    const replacement = `(${exprText} ${identity.op})`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
