/**
 * Rule: pascal-intrinsic-swap
 *
 * Swap equivalent Pascal intrinsics: ord() <-> integer(), chr() <-> char().
 */
import type { MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const SWAP_MAP: Record<string, string> = {
  ord: 'integer',
  integer: 'ord',
  chr: 'char',
  char: 'chr',
};

export const pascalIntrinsicSwap: Rule = {
  id: 'pascal-intrinsic-swap',
  description: 'Swap equivalent Pascal intrinsics (ord/integer, chr/char).',
  languages: ['pascal'],
  defaultWeight: 10,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const candidates = findAllByKind(fn, 'exprCall').filter((n) => {
      const funcNode = n.children()[0];
      if (!funcNode || funcNode.kind() !== 'identifier') {
        return false;
      }
      return funcNode.text().toLowerCase() in SWAP_MAP;
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const funcNode = node.children()[0]!;
    const funcName = funcNode.text().toLowerCase();
    const replacement = SWAP_MAP[funcName]!;

    const funcRange = funcNode.range();

    return {
      source: replaceRange(source, funcRange.start.index, funcRange.end.index, replacement),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
