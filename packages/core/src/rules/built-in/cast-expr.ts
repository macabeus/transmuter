/**
 * Rule: cast-expr
 *
 * Add a type cast to a random expression.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const CAST_TYPES = [
  'int',
  'unsigned',
  'unsigned int',
  'char',
  'unsigned char',
  'short',
  'unsigned short',
  'long',
  'unsigned long',
  's8',
  's16',
  's32',
  'u8',
  'u16',
  'u32',
];

export const castExpr: Rule = {
  id: 'cast-expr',
  description: 'Add a type cast to a random expression.',
  languages: ['c', 'cpp'],
  defaultWeight: 20,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find identifier and binary_expression nodes
    const identifiers = findAllByKind(fn, 'identifier');
    const binaryExprs = findAllByKind(fn, 'binary_expression');
    const candidates = [...identifiers, ...binaryExprs].filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      // Skip identifiers that are function names in call expressions
      const parent = n.parent();
      if (parent && parent.kind() === 'call_expression' && isSameNode(parent.field('function'), n)) {
        return false;
      }
      // Skip identifiers that are declaration names
      if (parent && parent.kind() === 'declaration') {
        return false;
      }
      // Skip identifiers that are already inside a cast
      if (parent && parent.kind() === 'cast_expression') {
        return false;
      }
      // Skip identifiers in the function declarator (the function's own name)
      if (parent && parent.kind() === 'function_declarator') {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const castType = rng.pick(CAST_TYPES);
    const range = node.range();
    const exprText = node.text();

    const replacement = `(${castType})${exprText}`;

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
