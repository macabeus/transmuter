/**
 * Rule: add-mask
 *
 * Add a bitwise AND mask to an expression.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const MASKS = ['0xFF', '0xFFFF', '0xFFFFFFFF', '0x1', '0x7F', '0x3'];

export const addMask: Rule = {
  id: 'add-mask',
  description: 'Add a bitwise AND mask to an expression.',
  languages: ['c', 'cpp'],
  defaultWeight: 15,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find identifier nodes that are in expression contexts
    const candidates = findAllByKind(fn, 'identifier').filter((n) => {
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
      // Skip identifiers in declaration names
      if (parent.kind() === 'declaration') {
        return false;
      }
      if (parent.kind() === 'init_declarator' && isSameNode(parent.field('declarator'), n)) {
        return false;
      }
      // Skip type identifiers
      if (n.kind() === 'type_identifier') {
        return false;
      }
      // Skip identifiers in the function declarator (the function's own name)
      if (parent.kind() === 'function_declarator') {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const mask = rng.pick(MASKS);
    const range = node.range();
    const exprText = node.text();

    const replacement = `(${exprText} & ${mask})`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
