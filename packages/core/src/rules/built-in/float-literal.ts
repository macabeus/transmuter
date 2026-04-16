/**
 * Rule: float-literal
 *
 * Randomize float literal representation.
 * For example: `1.0` -> `1.0f`, `1.0f` -> `(float)1.0`, `0.5` -> `(1.0 / 2.0)`.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const floatLiteral: Rule = {
  id: 'float-literal',
  description: 'Randomize float literal representation.',
  languages: ['c', 'cpp'],
  defaultWeight: 3,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find number_literal nodes that contain '.' (float literals)
    const candidates = findAllByKind(fn, 'number_literal').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      const text = n.text();
      return text.includes('.');
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const range = node.range();
    const text = node.text();

    // Determine what transformations are available
    const transformations: string[] = [];

    const hasFSuffix = text.endsWith('f') || text.endsWith('F');
    const baseText = hasFSuffix ? text.slice(0, -1) : text;
    const numVal = parseFloat(baseText);

    if (hasFSuffix) {
      // `1.0f` -> `(float)1.0` or strip the suffix
      transformations.push(`(float)${baseText}`);
      transformations.push(baseText);
    } else {
      // `1.0` -> `1.0f` or `(float)1.0`
      transformations.push(`${text}f`);
      transformations.push(`(float)${text}`);
    }

    // For simple fractions, try expressing as division
    if (!isNaN(numVal) && numVal !== 0.0 && numVal > 0 && numVal < 100) {
      // Check if this is a simple fraction a/b where b is a small power of 2
      for (const denom of [2, 4, 8, 16]) {
        const numer = numVal * denom;
        if (Number.isInteger(numer) && numer > 0 && numer < 1000) {
          transformations.push(`(${numer}.0 / ${denom}.0)`);
          break;
        }
      }
    }

    if (transformations.length === 0) {
      return null;
    }

    const replacement = rng.pick(transformations);

    return {
      source: replaceRange(source, range.start.index, range.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
