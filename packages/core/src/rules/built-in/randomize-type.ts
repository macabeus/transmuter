/**
 * Rule: randomize-type
 *
 * Randomize the type of a local variable declaration.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const C_TYPES = [
  'int',
  'unsigned',
  'unsigned int',
  'short',
  'unsigned short',
  'long',
  'unsigned long',
  'char',
  'unsigned char',
  'u8',
  'u16',
  'u32',
  's8',
  's16',
  's32',
];

export const randomizeType: Rule = {
  id: 'randomize-type',
  description: 'Randomize the type of a local variable declaration.',
  languages: ['c', 'cpp'],
  defaultWeight: 50,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all declaration nodes inside the function
    const decls = findAllByKind(fn, 'declaration');
    if (decls.length === 0) {
      return null;
    }

    // Filter out pointer declarations and declarations without a type specifier
    const candidates = decls.filter((decl) => {
      const declText = decl.text();
      // Skip pointer declarations (contains * in the declarator area)
      if (declText.includes('*')) {
        return false;
      }

      // Must have a type field
      const typeNode = decl.field('type');
      if (!typeNode) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    const decl = rng.pick(candidates);
    const typeNode = decl.field('type')!;
    const typeRange = typeNode.range();

    // Pick a random type that differs from the current one
    const currentType = typeNode.text();
    const availableTypes = C_TYPES.filter((t) => t !== currentType);
    if (availableTypes.length === 0) {
      return null;
    }

    const newType = rng.pick(availableTypes);

    return {
      source: replaceRange(source, typeRange.start.index, typeRange.end.index, newType),
      location: { line: decl.range().start.line + 1, column: decl.range().start.column + 1 },
    };
  },
};
