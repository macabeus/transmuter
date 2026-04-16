/**
 * Rule: explicit-this
 *
 * Add or remove explicit `this->` on member access in C++ methods.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const explicitThis: Rule = {
  id: 'explicit-this',
  description: 'Add or remove explicit this-> on member access in C++ methods.',
  languages: ['cpp'],
  defaultWeight: 15,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'cpp');
    if (!fn) {
      return null;
    }

    const direction = rng.pick(['add', 'remove'] as const);

    if (direction === 'remove') {
      // Find `this->member` field_expression nodes
      const candidates = findAllByKind(fn, 'field_expression').filter((n) => {
        if (isInsideAsm(n)) {
          return false;
        }
        const arg = n.field('argument');
        return arg !== null && arg.text() === 'this';
      });

      if (candidates.length === 0) {
        return null;
      }

      const node = rng.pick(candidates);
      const field = node.field('field');
      if (!field) {
        return null;
      }

      const range = node.range();
      return {
        source: replaceRange(source, range.start.index, range.end.index, field.text()),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    } else {
      // Find identifiers that could be implicit member accesses
      const candidates = findAllByKind(fn, 'identifier').filter((n) => {
        if (isInsideAsm(n)) {
          return false;
        }
        const parent = n.parent();
        if (!parent) {
          return false;
        }
        // Skip identifiers already inside a field_expression (e.g., `this->x` or `obj.x`)
        if (parent.kind() === 'field_expression') {
          return false;
        }
        // Skip function names in call expressions
        if (parent.kind() === 'call_expression' && isSameNode(parent.field('function'), n)) {
          return false;
        }
        // Skip type names in declarations
        if (parent.kind() === 'declaration' && isSameNode(parent.field('type'), n)) {
          return false;
        }
        // Skip identifiers in the function declarator (the function's own name)
        if (parent.kind() === 'function_declarator' || parent.kind() === 'qualified_identifier') {
          return false;
        }
        return true;
      });

      if (candidates.length === 0) {
        return null;
      }

      const node = rng.pick(candidates);
      const range = node.range();
      const replacement = `this->${node.text()}`;

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    }
  },
};
