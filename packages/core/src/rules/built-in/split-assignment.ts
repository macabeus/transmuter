/**
 * Rule: split-assignment
 *
 * Split a field-access chain assignment into two statements using a temporary.
 * For example: `a = b.c.d;` becomes `temp = b.c; a = temp.d;`
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, isInsideAsm, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const splitAssignment: Rule = {
  id: 'split-assignment',
  description: 'Split a field-access chain into two assignments via a temporary.',
  languages: ['c', 'cpp'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find assignment expressions where the RHS contains a field_expression chain
    const candidates = findAllByKind(fn, 'assignment_expression').filter((n) => {
      if (isInsideAsm(n)) {
        return false;
      }
      // Must use plain '=' operator
      const children = n.children();
      const opNode = children.find((c) => c.text() === '=');
      if (!opNode) {
        return false;
      }

      const right = n.field('right');
      if (!right) {
        return false;
      }

      // RHS must be a field_expression whose argument is also a field_expression
      // (i.e., a chain of at least 2 field accesses)
      if (right.kind() !== 'field_expression') {
        return false;
      }
      const innerArg = right.field('argument');
      if (!innerArg) {
        return false;
      }
      return innerArg.kind() === 'field_expression';
    });

    if (candidates.length === 0) {
      return null;
    }

    const node = rng.pick(candidates);
    const left = node.field('left');
    const right = node.field('right');
    if (!left || !right) {
      return null;
    }

    // right is `b.c.d` — a field_expression
    // right.argument = `b.c`, right.field = `d`
    const innerChain = right.field('argument');
    const outerField = right.field('field');
    if (!innerChain || !outerField) {
      return null;
    }

    // Determine the operator: could be '.' or '->'
    const rightChildren = right.children();
    let accessOp = '.';
    for (const child of rightChildren) {
      const text = child.text();
      if (text === '->' || text === '.') {
        accessOp = text;
        break;
      }
    }

    // Walk up to find the enclosing statement
    let stmt = node;
    while (stmt.parent() && stmt.parent()!.kind() !== 'compound_statement') {
      stmt = stmt.parent()!;
    }
    if (!stmt.parent()) {
      return null;
    }

    const stmtRange = stmt.range();
    const indent = getIndentation(source, stmt);

    const tempNum = rng.int(0, 999);
    const tempName = `_t${tempNum}`;

    // Build: `int _tN = b.c;\n    a = _tN.d;` (or ->d)
    // We replace the entire statement
    const tempDecl = `${indent}int ${tempName} = ${innerChain.text()};\n`;
    const newAssign = `${indent}${left.text()} = ${tempName}${accessOp}${outerField.text()};`;

    return {
      source: replaceRange(source, stmtRange.start.index, stmtRange.end.index, tempDecl + newAssign),
      location: { line: node.range().start.line + 1, column: node.range().start.column + 1 },
    };
  },
};
