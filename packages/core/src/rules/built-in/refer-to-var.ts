/**
 * Rule: refer-to-var
 *
 * Create a pointer to a local variable and dereference it.
 * Inserts `type *_ptrN = &varName;` after a declaration, then replaces
 * one usage of `varName` with `*_ptrN`.
 */
import type { SgNode } from '@ast-grep/napi';
import type { MutationApplyResult } from '~/types.js';

import {
  findAllByKind,
  findTargetFunction,
  getDeclarations,
  getIndentation,
  isInsideAsm,
  isSameNode,
  replaceRange,
} from '../helpers.js';
import type { MutationContext, Rule } from '../rule.js';

interface VarInfo {
  name: string;
  typeText: string;
  declNode: SgNode;
}

/** Extract variable name and type from a declaration node. */
function extractVarInfo(decl: SgNode): VarInfo | null {
  const typeNode = decl.field('type');
  if (!typeNode) {
    return null;
  }
  const typeText = typeNode.text();

  // Look for init_declarator (e.g., `int x = 0;`)
  const initDeclarators = findAllByKind(decl, 'init_declarator');
  for (const d of initDeclarators) {
    const ident = d.field('declarator');
    if (ident && ident.kind() === 'identifier') {
      return { name: ident.text(), typeText, declNode: decl };
    }
  }

  // Plain declaration (e.g., `int x;`)
  const identifiers = findAllByKind(decl, 'identifier');
  for (const ident of identifiers) {
    const parent = ident.parent();
    if (parent && parent.kind() === 'declaration') {
      // Skip if this identifier matches the type (typedef name)
      if (ident.text() === typeText) {
        continue;
      }
      return { name: ident.text(), typeText, declNode: decl };
    }
  }

  return null;
}

export const referToVar: Rule = {
  id: 'refer-to-var',
  description: 'Create a pointer to a local variable and dereference one usage.',
  languages: ['c', 'cpp'],
  defaultWeight: 3,

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return null;
    }

    const body = fn.find({ rule: { kind: 'compound_statement' } });
    if (!body) {
      return null;
    }

    const decls = getDeclarations(body);
    if (decls.length === 0) {
      return null;
    }

    // Collect variable info from declarations
    const vars: VarInfo[] = [];
    for (const decl of decls) {
      const info = extractVarInfo(decl);
      if (info) {
        vars.push(info);
      }
    }
    if (vars.length === 0) {
      return null;
    }

    // Shuffle and try each variable until we find one with a usable reference
    const shuffledVars = rng.shuffle([...vars]);

    for (const varInfo of shuffledVars) {
      // Find usages of this variable in the function body (after its declaration)
      const declEndIndex = varInfo.declNode.range().end.index;

      const usages = fn.findAll({ rule: { kind: 'identifier', regex: `^${varInfo.name}$` } }).filter((n) => {
        if (isInsideAsm(n)) {
          return false;
        }
        // Must be after the declaration
        if (n.range().start.index <= declEndIndex) {
          return false;
        }
        const parent = n.parent();
        if (!parent) {
          return false;
        }
        // Skip LHS of assignments
        if (parent.kind() === 'assignment_expression' && isSameNode(parent.field('left'), n)) {
          return false;
        }
        // Skip function call names
        if (parent.kind() === 'call_expression' && isSameNode(parent.field('function'), n)) {
          return false;
        }
        // Skip declaration names
        if (parent.kind() === 'declaration') {
          return false;
        }
        if (parent.kind() === 'init_declarator' && isSameNode(parent.field('declarator'), n)) {
          return false;
        }
        // Skip address-of operands (would create &&)
        if (parent.kind() === 'unary_expression' && parent.text().startsWith('&')) {
          return false;
        }
        return true;
      });

      if (usages.length === 0) {
        continue;
      }

      const usage = rng.pick(usages);
      const ptrNum = rng.int(0, 999);
      const ptrName = `_ptr${ptrNum}`;

      // Step 1: Insert pointer declaration after the variable declaration
      const declRange = varInfo.declNode.range();
      const indent = getIndentation(source, varInfo.declNode);
      const ptrDecl = `\n${indent}${varInfo.typeText} *${ptrName} = &${varInfo.name};`;

      let result = replaceRange(source, declRange.end.index, declRange.end.index, ptrDecl);

      // Step 2: Replace the usage with dereference
      // Adjust index because we inserted text before it
      const insertedLength = ptrDecl.length;
      const usageRange = usage.range();
      const adjustedStart = usageRange.start.index + insertedLength;
      const adjustedEnd = usageRange.end.index + insertedLength;

      result = replaceRange(result, adjustedStart, adjustedEnd, `(*${ptrName})`);

      return {
        source: result,
        location: { line: usage.range().start.line + 1, column: usage.range().start.column + 1 },
      };
    }

    return null;
  },
};
