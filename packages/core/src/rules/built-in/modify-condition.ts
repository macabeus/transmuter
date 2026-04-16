/**
 * Rule: modify-condition
 *
 * Modify a conditional expression in various ways:
 *   - `if (a)` -> `if (!!a)` (double negation)
 *   - `if (a == b)` -> `if (!(a != b))` (negate comparison)
 *   - `if (a)` -> `if (a != 0)` (explicit zero comparison)
 *   - `if (!a)` -> `if (a == 0)` (replace not with zero comparison)
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

/** Map comparison operators to their negated counterparts. */
const NEGATE_OP: Record<string, string> = {
  '==': '!=',
  '!=': '==',
  '<': '>=',
  '>': '<=',
  '<=': '>',
  '>=': '<',
};

/** Extract the condition node from an if_statement or while_statement. */
function getCondition(node: SgNode): SgNode | null {
  return node.field('condition') ?? null;
}

export const modifyCondition: Rule = {
  id: 'modify-condition',
  description: 'Modify a conditional expression (double negate, explicit zero comparison, etc.).',
  languages: ['c', 'cpp'],
  defaultWeight: 15,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find if_statement and while_statement nodes
    const ifStmts = findAllByKind(fn, 'if_statement');
    const whileStmts = findAllByKind(fn, 'while_statement');
    const candidates = [...ifStmts, ...whileStmts].filter((n) => !isInsideAsm(n));

    if (candidates.length === 0) {
      return null;
    }

    const stmt = rng.pick(candidates);
    const condition = getCondition(stmt);
    if (!condition) {
      return null;
    }

    // The condition is wrapped in a parenthesized_expression: `(cond)`
    // We need the inner expression
    let innerCond: SgNode;
    if (condition.kind() === 'parenthesized_expression') {
      const children = condition.children().filter((c) => c.kind() !== '(' && c.kind() !== ')');
      if (children.length !== 1) {
        return null;
      }
      innerCond = children[0]!;
    } else {
      innerCond = condition;
    }

    const condText = innerCond.text();
    const condRange = innerCond.range();

    // Build a list of applicable transformations
    const transforms: (() => string)[] = [];

    // 1. Double negation: `a` -> `!!a`
    transforms.push(() => `!!${condText}`);

    // 2. Negate comparison: `a == b` -> `!(a != b)`
    if (innerCond.kind() === 'binary_expression') {
      const children = innerCond.children();
      // Find the operator node
      for (const child of children) {
        const op = child.text();
        if (op in NEGATE_OP) {
          const left = innerCond.field('left');
          const right = innerCond.field('right');
          if (left && right) {
            const negOp = NEGATE_OP[op]!;
            transforms.push(() => `!(${left.text()} ${negOp} ${right.text()})`);
          }
          break;
        }
      }
    }

    // 3. Explicit zero comparison: `a` -> `a != 0`
    // Only when the condition is not already a comparison
    if (innerCond.kind() !== 'binary_expression' && innerCond.kind() !== 'unary_expression') {
      transforms.push(() => `${condText} != 0`);
    }

    // 4. Replace `!a` with `a == 0`
    if (innerCond.kind() === 'unary_expression') {
      const children = innerCond.children();
      const opNode = children.find((c) => c.text() === '!');
      if (opNode) {
        const operand = innerCond.field('argument');
        if (operand) {
          transforms.push(() => `${operand.text()} == 0`);
        }
      }
    }

    if (transforms.length === 0) {
      return null;
    }

    const transform = rng.pick(transforms);
    const replacement = transform();

    return {
      source: replaceRange(source, condRange.start.index, condRange.end.index, replacement),
      location: { line: innerCond.range().start.line + 1, column: innerCond.range().start.column + 1 },
    };
  },
};
