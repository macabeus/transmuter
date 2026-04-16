/**
 * Rule: cast-style-swap
 *
 * Convert between C-style casts and `static_cast` in C++ code.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const castStyleSwap: Rule = {
  id: 'cast-style-swap',
  description: 'Convert between C-style casts and static_cast in C++ code.',
  languages: ['cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'cpp');
    if (!fn) {
      return null;
    }

    const direction = rng.pick(['c-to-cpp', 'cpp-to-c'] as const);

    if (direction === 'c-to-cpp') {
      // Find C-style cast_expression nodes like `(int)x`
      const candidates = findAllByKind(fn, 'cast_expression').filter((n) => !isInsideAsm(n));

      if (candidates.length === 0) {
        return null;
      }

      const node = rng.pick(candidates);
      const typeNode = node.field('type');
      const valueNode = node.field('value');
      if (!typeNode || !valueNode) {
        return null;
      }

      const range = node.range();
      const replacement = `static_cast<${typeNode.text()}>(${valueNode.text()})`;

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    } else {
      // Find static_cast<T>(expr) call expressions
      const candidates = findAllByKind(fn, 'call_expression').filter((n) => {
        if (isInsideAsm(n)) {
          return false;
        }
        const func = n.field('function');
        if (!func || func.kind() !== 'template_function') {
          return false;
        }
        const name = func.field('name');
        return name !== null && name.text() === 'static_cast';
      });

      if (candidates.length === 0) {
        return null;
      }

      const node = rng.pick(candidates);
      const func = node.field('function')!;
      const templateArgs = func.field('arguments');
      if (!templateArgs) {
        return null;
      }

      // Extract the type from template arguments (strip < and >)
      const typeChildren = templateArgs.children().filter((c) => c.kind() !== '<' && c.kind() !== '>');
      if (typeChildren.length === 0) {
        return null;
      }
      const castType = typeChildren.map((c) => c.text()).join(', ');

      // Extract the argument from the call's argument_list
      const args = node.field('arguments');
      if (!args) {
        return null;
      }
      const argChildren = args.children().filter((c) => c.kind() !== '(' && c.kind() !== ')' && c.kind() !== ',');
      if (argChildren.length === 0) {
        return null;
      }
      const argText = argChildren[0]!.text();

      const range = node.range();
      const replacement = `(${castType})${argText}`;

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    }
  },
};
