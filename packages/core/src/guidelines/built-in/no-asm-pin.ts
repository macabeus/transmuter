/**
 * Guideline: no-asm-pin
 *
 * Detects two forms of inline asm used for register control:
 *
 * 1. **Asm barrier statements**: `asm("" : "+r"(var));`
 *    Expression statements containing a gnu_asm_expression.
 *    Removal: delete the entire statement.
 *
 * 2. **Register asm pins**: `register s32 shifted asm("r1") = result;`
 *    Declarations with a storage_class_specifier("register") and a
 *    gnu_asm_expression child. Removal: strip `register` and `asm("rN")`,
 *    leaving a plain declaration.
 */
import type { SgNode } from '@ast-grep/napi';
import { parseCached } from '~/parser.js';
import { findTargetFunction } from '~/rules/helpers.js';

import type { Guideline, Violation } from '../guideline.js';

export const noAsmPin: Guideline = {
  id: 'no-asm-pin',
  description: 'Replace asm() register barriers and pins with equivalent C code.',
  languages: ['c'],
  disabledRules: ['asm-barrier', 'asm-register-swap'],

  detect(source: string, functionName: string): Violation[] {
    const root = parseCached('c', source);
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return [];
    }

    const violations: Violation[] = [];

    // Form 1: expression_statement containing gnu_asm_expression
    // e.g., `asm("" : "+r"(var));`
    const stmts = fn.findAll({ rule: { kind: 'expression_statement' } });
    for (const stmt of stmts) {
      const asmExpr = stmt.find({ rule: { kind: 'gnu_asm_expression' } });
      if (!asmExpr) {
        continue;
      }

      const startLine = stmt.range().start.line + 1;
      const endLine = stmt.range().end.line + 1;

      violations.push({
        id: `asm-barrier:L${startLine}`,
        lines: { start: startLine, end: endLine },
        description: `Inline asm barrier: ${stmt.text().trim()}`,
        text: stmt.text(),
      });
    }

    // Form 2: declaration with register + gnu_asm_expression
    // e.g., `register s32 shifted asm("r1") = result;`
    const decls = fn.findAll({ rule: { kind: 'declaration' } });
    for (const decl of decls) {
      if (!hasRegisterStorage(decl)) {
        continue;
      }
      const asmExpr = decl.find({ rule: { kind: 'gnu_asm_expression' } });
      if (!asmExpr) {
        continue;
      }

      const startLine = decl.range().start.line + 1;
      const endLine = decl.range().end.line + 1;

      violations.push({
        id: `asm-pin:L${startLine}`,
        lines: { start: startLine, end: endLine },
        description: `Register asm pin: ${decl.text().trim()}`,
        text: decl.text(),
      });
    }

    return violations;
  },

  remove(source: string, violation: Violation): string | null {
    if (violation.id.startsWith('asm-barrier:')) {
      // Form 1: delete the entire statement
      const lines = source.split('\n');
      const result: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (lineNum >= violation.lines.start && lineNum <= violation.lines.end) {
          continue;
        }
        result.push(lines[i]!);
      }
      return result.join('\n');
    }

    // Form 2: strip `register` keyword and `asm("rN")` from the declaration
    // "register s32 shifted asm("r1") = result;" → "s32 shifted = result;"
    const lines = source.split('\n');
    for (let i = violation.lines.start - 1; i < violation.lines.end && i < lines.length; i++) {
      let line = lines[i]!;
      // Remove `register ` keyword
      line = line.replace(/\bregister\s+/, '');
      // Remove `asm("...")` or `asm("..." : ...)` — match the asm(...) portion
      line = line.replace(/\s*asm\s*\([^)]*\)\s*/, ' ');
      lines[i] = line;
    }
    return lines.join('\n');
  },

  containsViolation(source: string, violation: Violation): boolean {
    // AST-based check: parse the source and look for any gnu_asm_expression
    // within the target function. This is more robust than string matching
    // because it handles reformatted code (whitespace changes, reordering).
    const root = parseCached('c', source);

    // Extract function name from the violation's id prefix — we need it
    // to scope the check to the target function. Since we don't have it
    // directly, check the entire translation unit for any asm form.
    const allFns = root.root().findAll({ rule: { kind: 'function_definition' } });

    for (const fn of allFns) {
      if (violation.id.startsWith('asm-barrier:')) {
        // Check for any expression_statement containing gnu_asm_expression
        const stmts = fn.findAll({ rule: { kind: 'expression_statement' } });
        for (const stmt of stmts) {
          if (stmt.find({ rule: { kind: 'gnu_asm_expression' } })) {
            return true;
          }
        }
      } else {
        // Check for any declaration with register + gnu_asm_expression
        const decls = fn.findAll({ rule: { kind: 'declaration' } });
        for (const decl of decls) {
          if (hasRegisterStorage(decl) && decl.find({ rule: { kind: 'gnu_asm_expression' } })) {
            return true;
          }
        }
      }
    }

    return false;
  },
};

function hasRegisterStorage(decl: SgNode): boolean {
  for (const child of decl.children()) {
    if (child.kind() === 'storage_class_specifier' && child.text() === 'register') {
      return true;
    }
  }
  return false;
}
