/**
 * Rule: expand-expr
 *
 * Replace a variable reference with its assigned value (inline expansion).
 * Finds a simple assignment `var = expr;` in the function, then finds a
 * later use of `var` and replaces it with `expr`.
 */
import type { SgNode } from '@ast-grep/napi';
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getStatements, isInsideAsm, isSameNode, replaceRange } from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

/** Check if an expression is simple enough to inline. */
function isSimpleExpr(node: SgNode): boolean {
  const kind = node.kind();
  return (
    kind === 'identifier' ||
    kind === 'number_literal' ||
    kind === 'string_literal' ||
    kind === 'char_literal' ||
    kind === 'field_expression' ||
    kind === 'binary_expression'
  );
}

interface AssignmentInfo {
  varName: string;
  exprText: string;
  /** End index of the assignment statement in source */
  stmtEndIndex: number;
}

/** Extract a simple `var = expr;` assignment from a statement. */
function extractAssignment(stmt: SgNode): AssignmentInfo | null {
  if (stmt.kind() !== 'expression_statement') {
    return null;
  }

  const assign = stmt.find({ rule: { kind: 'assignment_expression' } });
  if (!assign) {
    return null;
  }

  // Must use plain '=' operator
  const children = assign.children();
  const opNode = children.find((c) => c.text() === '=');
  if (!opNode) {
    return null;
  }

  const left = assign.field('left');
  const right = assign.field('right');
  if (!left || !right) {
    return null;
  }

  // LHS must be a plain identifier
  if (left.kind() !== 'identifier') {
    return null;
  }

  // RHS must be a simple expression
  if (!isSimpleExpr(right)) {
    return null;
  }

  return {
    varName: left.text(),
    exprText: right.text(),
    stmtEndIndex: stmt.range().end.index,
  };
}

export const expandExpr: Rule = {
  id: 'expand-expr',
  description: 'Replace a variable reference with its assigned value (inline expansion).',
  languages: ['c', 'cpp'],
  defaultWeight: 80,
  relevantDiffTypes: new Set<DiffType>(['insert', 'delete', 'argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find all compound_statement blocks
    const blocks = findAllByKind(fn, 'compound_statement');
    if (blocks.length === 0) {
      return null;
    }

    // Collect all eligible (assignment, use) pairs
    const expansions: { use: SgNode; exprText: string }[] = [];

    for (const block of blocks) {
      const stmts = getStatements(block);

      for (let i = 0; i < stmts.length - 1; i++) {
        const assignment = extractAssignment(stmts[i]!);
        if (!assignment) {
          continue;
        }

        // Look at subsequent statements for uses of the variable
        for (let j = i + 1; j < stmts.length; j++) {
          const laterStmt = stmts[j]!;

          // Check if `var` is reassigned in this statement — if so, stop
          const reassignCandidates = findAllByKind(laterStmt, 'assignment_expression');
          const reassign = reassignCandidates.some((a) => {
            const left = a.field('left');
            return left && left.kind() === 'identifier' && left.text() === assignment.varName;
          });

          // Find uses of the variable in this statement
          const uses = laterStmt
            .findAll({ rule: { kind: 'identifier', regex: `^${assignment.varName}$` } })
            .filter((n) => {
              if (isInsideAsm(n)) {
                return false;
              }
              const parent = n.parent();
              // Skip if this is the LHS of an assignment
              if (parent && parent.kind() === 'assignment_expression' && isSameNode(parent.field('left'), n)) {
                return false;
              }
              // Skip function call names
              if (parent && parent.kind() === 'call_expression' && isSameNode(parent.field('function'), n)) {
                return false;
              }
              // Skip declaration names
              if (parent && parent.kind() === 'declaration') {
                return false;
              }
              if (parent && parent.kind() === 'init_declarator' && isSameNode(parent.field('declarator'), n)) {
                return false;
              }
              return true;
            });

          for (const use of uses) {
            expansions.push({ use, exprText: assignment.exprText });
          }

          // If the variable is reassigned in this statement, stop looking further
          if (reassign) {
            break;
          }
        }
      }
    }

    if (expansions.length === 0) {
      return null;
    }

    const expansion = rng.pick(expansions);
    const useRange = expansion.use.range();

    return {
      source: replaceRange(source, useRange.start.index, useRange.end.index, expansion.exprText),
      location: { line: expansion.use.range().start.line + 1, column: expansion.use.range().start.column + 1 },
    };
  },
};
