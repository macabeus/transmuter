/**
 * Rule: asm-register-swap
 *
 * Swap register constraints in existing inline asm blocks between "r" (any
 * register) and "l" (low register, r0-r7 on ARM/Thumb).
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

/** Patterns we look for and what they swap to. */
const SWAPS: Record<string, string> = {
  '"+r"': '"+l"',
  '"+l"': '"+r"',
  '"=r"': '"=l"',
  '"=l"': '"=r"',
  '"r"': '"l"',
  '"l"': '"r"',
};

export const asmRegisterSwap: Rule = {
  id: 'asm-register-swap',
  description: 'Swap register constraints in inline asm between "r" and "l".',
  languages: ['c'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all gnu_asm_expression nodes
    const asmNodes = findAllByKind(fn, 'gnu_asm_expression');
    if (asmNodes.length === 0) {
      return null;
    }

    // Collect all swappable constraint locations across all asm nodes
    const swapTargets: { start: number; end: number; replacement: string; asmNode: import('@ast-grep/napi').SgNode }[] =
      [];

    for (const asmNode of asmNodes) {
      const asmText = asmNode.text();
      const asmStart = asmNode.range().start.index;

      // Search for each swap pattern within the asm node's text
      for (const [pattern, replacement] of Object.entries(SWAPS)) {
        let searchFrom = 0;
        while (true) {
          const idx = asmText.indexOf(pattern, searchFrom);
          if (idx === -1) {
            break;
          }
          swapTargets.push({
            start: asmStart + idx,
            end: asmStart + idx + pattern.length,
            replacement,
            asmNode,
          });
          searchFrom = idx + pattern.length;
        }
      }
    }

    if (swapTargets.length === 0) {
      return null;
    }

    const target = rng.pick(swapTargets);

    return {
      source: replaceRange(source, target.start, target.end, target.replacement),
      location: { line: target.asmNode.range().start.line + 1, column: target.asmNode.range().start.column + 1 },
    };
  },
};
