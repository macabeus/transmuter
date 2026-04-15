/**
 * Guideline: no-c-style-cast
 *
 * Detects C-style casts in C++ code (e.g., `(int)x`) and removes them.
 * Common artifact in decompiled C++ output where casts are often redundant.
 * Removal strips the cast and keeps only the inner expression.
 */
import { parseCached } from '~/parser.js';
import { findTargetFunction } from '~/rules/helpers.js';

import type { Guideline, Violation } from '../guideline.js';

export const noCStyleCast: Guideline = {
  id: 'no-c-style-cast',
  description: 'Remove redundant C-style casts in C++ code.',
  languages: ['cpp'],
  disabledRules: ['cast-expr'],

  detect(source: string, functionName: string): Violation[] {
    const root = parseCached('cpp', source);
    const fn = findTargetFunction(root, functionName, 'cpp');
    if (!fn) {
      return [];
    }

    const casts = fn.findAll({ rule: { kind: 'cast_expression' } });
    const violations: Violation[] = [];

    for (const cast of casts) {
      const startLine = cast.range().start.line + 1;
      const startCol = cast.range().start.column + 1;
      const endLine = cast.range().end.line + 1;
      violations.push({
        id: `c-cast:L${startLine}:C${startCol}`,
        lines: { start: startLine, end: endLine },
        description: `C-style cast at line ${startLine}:${startCol}`,
        text: cast.text(),
      });
    }

    return violations;
  },

  remove(source: string, violation: Violation): string | null {
    const root = parseCached('cpp', source);
    const casts = root.root().findAll({ rule: { kind: 'cast_expression' } });

    for (const cast of casts) {
      const startLine = cast.range().start.line + 1;
      if (startLine !== violation.lines.start) {
        continue;
      }
      if (cast.text() !== violation.text) {
        continue;
      }

      const children = cast.children();
      // cast_expression children: '(' type_descriptor ')' value
      const value = children[children.length - 1];
      if (!value || value.kind() === ')') {
        continue;
      }

      // Strip the cast, keeping only the value expression.
      // If the value is a parenthesized_expression, unwrap it too to avoid double parens.
      let replacement = value.text();
      if (value.kind() === 'parenthesized_expression') {
        const inner = value.children().filter((c) => c.kind() !== '(' && c.kind() !== ')');
        if (inner.length === 1) {
          replacement = inner[0]!.text();
        }
      }

      const start = cast.range().start.index;
      const end = cast.range().end.index;
      return source.slice(0, start) + replacement + source.slice(end);
    }

    return null;
  },
};
