/**
 * Guideline: no-goto
 *
 * Detects goto statements and removes them so the permuter can
 * find equivalent structured control flow.
 */
import { parseCached } from '~/parser.js';
import { findTargetFunction } from '~/rules/helpers.js';

import type { Guideline, Violation } from '../guideline.js';

export const noGoto: Guideline = {
  id: 'no-goto',
  description: 'Restructure goto statements into structured control flow.',
  languages: ['c', 'cpp'],
  disabledRules: [],

  detect(source: string, functionName: string): Violation[] {
    const root = parseCached('c', source);
    const fn = findTargetFunction(root, functionName);
    if (!fn) {
      return [];
    }

    const gotos = fn.findAll({ rule: { kind: 'goto_statement' } });
    const violations: Violation[] = [];

    for (const g of gotos) {
      const startLine = g.range().start.line + 1;
      const endLine = g.range().end.line + 1;

      violations.push({
        id: `goto:L${startLine}`,
        lines: { start: startLine, end: endLine },
        description: `goto statement: ${g.text().trim()}`,
        text: g.text(),
      });
    }

    return violations;
  },

  remove(source: string, violation: Violation): string | null {
    // Replace the goto with an empty statement.
    // This is a best-effort removal — the surrounding code may need
    // restructuring by the permuter to achieve a match.
    const lines = source.split('\n');
    const idx = violation.lines.start - 1;
    if (idx >= 0 && idx < lines.length) {
      const indent = lines[idx]!.match(/^(\s*)/)?.[1] ?? '';
      lines[idx] = `${indent};`;
    }
    return lines.join('\n');
  },

  containsViolation(source: string, violation: Violation): boolean {
    return source.includes(violation.text.trim());
  },
};
