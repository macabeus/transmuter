/**
 * Rule: self-assignment
 *
 * Insert `var = var;` for a local variable as a register allocation hint.
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import {
  findAllByKind,
  findTargetFunction,
  getDeclarations,
  getIndentation,
  getStatements,
  replaceRange,
} from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const selfAssignment: Rule = {
  id: 'self-assignment',
  description: 'Insert a self-assignment statement for a local variable.',
  languages: ['c', 'cpp'],
  defaultWeight: 5,
  relevantDiffTypes: new Set<DiffType>(['argMismatch']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    // Find the function body
    const body = fn.find({ rule: { kind: 'compound_statement' } });
    if (!body) {
      return null;
    }

    // Find local variable declarations to pick a variable name
    const decls = getDeclarations(body);
    if (decls.length === 0) {
      return null;
    }

    // Extract variable names from declarations
    const varNames: string[] = [];
    for (const decl of decls) {
      const declarators = findAllByKind(decl, 'init_declarator');
      const plainDeclarators = findAllByKind(decl, 'identifier');
      // init_declarator has an identifier child for initialized vars
      for (const d of declarators) {
        const ident = d.field('declarator');
        if (ident && ident.kind() === 'identifier') {
          varNames.push(ident.text());
        }
      }
      // For plain declarations like `int x;`, the identifier is a direct child
      // but we need to exclude type specifier identifiers
      if (declarators.length === 0) {
        for (const ident of plainDeclarators) {
          const parent = ident.parent();
          if (parent && parent.kind() === 'declaration') {
            // Skip type specifiers (first identifier is usually the type for typedef types)
            const typeNode = parent.field('type');
            if (typeNode && typeNode.text() === ident.text()) {
              continue;
            }
            varNames.push(ident.text());
          }
        }
      }
    }

    if (varNames.length === 0) {
      return null;
    }

    const varName = rng.pick(varNames);

    // Find all statements in the body to pick an insertion point
    const stmts = getStatements(body);
    if (stmts.length === 0) {
      return null;
    }

    // Insert after a random statement
    const insertAfter = rng.pick(stmts);
    const insertRange = insertAfter.range();
    const indent = getIndentation(source, insertAfter);

    const selfAssign = `\n${indent}${varName} = ${varName};`;

    return {
      source: replaceRange(source, insertRange.end.index, insertRange.end.index, selfAssign),
      location: { line: insertAfter.range().start.line + 1, column: insertAfter.range().start.column + 1 },
    };
  },
};
