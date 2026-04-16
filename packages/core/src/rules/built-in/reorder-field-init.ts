/**
 * Rule: reorder-field-init
 *
 * Reorder field initializers in a C++ constructor initializer list.
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, swapRanges } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const reorderFieldInit: Rule = {
  id: 'reorder-field-init',
  description: 'Reorder field initializers in a C++ constructor initializer list.',
  languages: ['cpp'],
  defaultWeight: 10,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'cpp');
    if (!fn) {
      return null;
    }

    const initLists = findAllByKind(fn, 'field_initializer_list');
    if (initLists.length === 0) {
      return null;
    }

    const initList = rng.pick(initLists);
    const initializers = initList.children().filter((c) => c.kind() === 'field_initializer');

    if (initializers.length < 2) {
      return null;
    }

    const idx = rng.int(0, initializers.length - 2);
    const a = initializers[idx]!;
    const b = initializers[idx + 1]!;

    const aRange = a.range();
    const bRange = b.range();

    return {
      source: swapRanges(source, aRange.start.index, aRange.end.index, bRange.start.index, bRange.end.index),
      location: { line: aRange.start.line + 1, column: aRange.start.column + 1 },
    };
  },
};
