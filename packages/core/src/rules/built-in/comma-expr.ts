/**
 * Rule: comma-expr
 *
 * Add a comma expression: `expr` -> `(0, expr)` or `((void)0, expr)`.
 * The comma operator evaluates the left side for side effects and returns
 * the right side. This can perturb code generation.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const commaExpr: Rule = {
  id: 'comma-expr',
  description: 'Wrap an expression with a comma operator: (0, expr).',
  languages: ['c', 'cpp'],
  defaultWeight: 3,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find identifier and call_expression nodes in expression contexts
    const identifiers = findAllByKind(fn, 'identifier');
    const callExprs = findAllByKind(fn, 'call_expression');
    const candidates = [...identifiers, ...callExprs].filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const parent = n.parent();
      if (!parent) {
        return false;
      }

      // Skip identifiers that are function names in call expressions
      if (n.kind() === 'identifier' && parent.kind() === 'call_expression' && isSameNode(parent.field('function'), n)) {
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
      // Skip if already inside a comma_expression (avoid nesting)
      if (parent.kind() === 'comma_expression') {
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
        parentKind === 'cast_expression'
      );
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const range = node.range();
    const exprText = node.text();

    // Randomly choose between `(0, expr)` and `((void)0, expr)`
    const prefix = rng.chance(0.5) ? '0' : '(void)0';
    const replacement = `(${prefix}, ${exprText})`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
