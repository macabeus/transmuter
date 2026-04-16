/**
 * Rule: compound-return
 *
 * Convert between plain and compound assignment forms in return statements:
 *   Fold:   `return (opt-cast)(var OP expr);` -> `return var OP= expr;`
 *   Expand: `return var OP= expr;`            -> `return (var OP expr);`
 *
 * Supports all compound operators: +, -, *, /, %, &, |, ^, <<, >>
 *
 * Unwraps casts, parenthesized_expression, and call_expression (tree-sitter
 * parses typedef casts like `(s16)(expr)` as call_expression with a single-arg
 * argument_list).
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

const COMPOUND_OPS = new Map([
  ['+', '+='],
  ['-', '-='],
  ['*', '*='],
  ['/', '/='],
  ['%', '%='],
  ['&', '&='],
  ['|', '|='],
  ['^', '^='],
  ['<<', '<<='],
  ['>>', '>>='],
]);

const EXPAND_OPS = new Map([
  ['+=', '+'],
  ['-=', '-'],
  ['*=', '*'],
  ['/=', '/'],
  ['%=', '%'],
  ['&=', '&'],
  ['|=', '|'],
  ['^=', '^'],
  ['<<=', '<<'],
  ['>>=', '>>'],
]);

interface FoldCandidate {
  returnNode: SgNode;
  kind: 'fold';
  varText: string;
  op: string;
  exprText: string;
}

interface ExpandCandidate {
  returnNode: SgNode;
  kind: 'expand';
  varText: string;
  op: string;
  exprText: string;
}

type Candidate = FoldCandidate | ExpandCandidate;

/**
 * Unwrap layers of cast_expression, parenthesized_expression, and
 * call_expression (typedef casts parsed as calls) to get the inner expression.
 */
function unwrap(node: SgNode): SgNode {
  let current = node;
  for (;;) {
    const kind = current.kind();
    if (kind === 'cast_expression') {
      const value = current.field('value');
      if (value) {
        current = value;
        continue;
      }
    }
    if (kind === 'parenthesized_expression') {
      const children = current.children();
      // Children: '(', inner, ')'
      const inner = children.find((c) => c.kind() !== '(' && c.kind() !== ')');
      if (inner) {
        current = inner;
        continue;
      }
    }
    if (kind === 'call_expression') {
      // tree-sitter parses `(type)(expr)` as call_expression
      // Check if arguments has exactly one child (single-arg argument_list)
      const args = current.field('arguments');
      if (args && args.kind() === 'argument_list') {
        const argChildren = args.children().filter((c) => c.kind() !== '(' && c.kind() !== ')' && c.kind() !== ',');
        if (argChildren.length === 1) {
          current = argChildren[0]!;
          continue;
        }
      }
    }
    break;
  }
  return current;
}

export const compoundReturn: Rule = {
  id: 'compound-return',
  description: 'Convert between plain and compound assignment in return statements.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    const candidates: Candidate[] = [];

    const returnStmts = findAllByKind(fn, 'return_statement');
    for (const ret of returnStmts) {
      if (isInsideAsm(ret)) {
        continue;
      }

      // Get the return value expression (skip 'return' keyword and ';')
      const retChildren = ret
        .children()
        .filter((c) => c.kind() !== 'return' && c.text() !== 'return' && c.kind() !== ';' && c.text() !== ';');
      if (retChildren.length !== 1) {
        continue;
      }
      const retExpr = retChildren[0]!;

      // --- Try fold: return (opt-cast)(var OP expr) -> return var OP= expr ---
      const inner = unwrap(retExpr);
      if (inner.kind() === 'binary_expression') {
        const children = inner.children();
        const leftNode = inner.field('left');
        const rightNode = inner.field('right');
        if (leftNode && rightNode && leftNode.kind() === 'identifier') {
          // Find the operator
          for (const child of children) {
            const text = child.text();
            if (COMPOUND_OPS.has(text)) {
              candidates.push({
                returnNode: ret,
                kind: 'fold',
                varText: leftNode.text(),
                op: COMPOUND_OPS.get(text)!,
                exprText: rightNode.text(),
              });
              break;
            }
          }
        }
      }

      // --- Try expand: return var OP= expr -> return (var OP expr) ---
      if (inner.kind() === 'assignment_expression') {
        const children = inner.children();
        const leftNode = inner.field('left');
        const rightNode = inner.field('right');
        if (leftNode && rightNode) {
          for (const child of children) {
            const text = child.text();
            if (EXPAND_OPS.has(text)) {
              candidates.push({
                returnNode: ret,
                kind: 'expand',
                varText: leftNode.text(),
                op: EXPAND_OPS.get(text)!,
                exprText: rightNode.text(),
              });
              break;
            }
          }
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const picked = rng.pick(candidates);
    const retRange = picked.returnNode.range();

    let replacement: string;
    if (picked.kind === 'fold') {
      replacement = `return ${picked.varText} ${picked.op} ${picked.exprText};`;
    } else {
      replacement = `return (${picked.varText} ${picked.op} ${picked.exprText});`;
    }

    return {
      source: replaceRange(source, retRange.start.index, retRange.end.index, replacement),
      location: { line: retRange.start.line + 1, column: retRange.start.column + 1 },
    };
  },
};
