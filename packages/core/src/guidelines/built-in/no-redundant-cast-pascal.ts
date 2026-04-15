/**
 * Guideline: no-redundant-cast-pascal
 *
 * Detects unnecessary function-style type casts in Pascal code where the
 * argument is a simple literal or identifier. Common in decompiled Pascal
 * where decompilers add defensive casts.
 *
 * Example: `integer(0)` → `0`, `char(x)` where x is already a char.
 */
import { parseCached } from '~/parser.js';
import { findTargetFunction } from '~/rules/helpers.js';

import type { Guideline, Violation } from '../guideline.js';

const CAST_NAMES = new Set(['integer', 'cardinal', 'boolean', 'char', 'byte', 'word', 'longint']);

/**
 * Extract the single argument from an exprCall node.
 * exprCall children: [identifier, '(', exprArgs, ')']
 * exprArgs children: [arg] (single argument) or [arg, ',', arg, ...] (multiple)
 * Returns the single argument node, or null if there are 0 or 2+ args.
 */
function getSingleArg(callNode: import('@ast-grep/napi').SgNode): import('@ast-grep/napi').SgNode | null {
  const exprArgs = callNode.children().find((c) => c.kind() === 'exprArgs');
  if (!exprArgs) {
    return null;
  }
  const args = exprArgs.children().filter((c) => c.kind() !== ',');
  if (args.length !== 1) {
    return null;
  }
  return args[0]!;
}

export const noRedundantCastPascal: Guideline = {
  id: 'no-redundant-cast-pascal',
  description: 'Remove redundant function-style type casts in Pascal code.',
  languages: ['pascal'],
  disabledRules: ['pascal-type-cast'],

  detect(source: string, functionName: string): Violation[] {
    const root = parseCached('pascal', source);
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return [];
    }

    const calls = fn.findAll({ rule: { kind: 'exprCall' } });
    const violations: Violation[] = [];

    for (const call of calls) {
      const nameNode = call.children()[0];
      if (!nameNode || nameNode.kind() !== 'identifier') {
        continue;
      }
      const name = nameNode.text().toLowerCase();
      if (!CAST_NAMES.has(name)) {
        continue;
      }

      const arg = getSingleArg(call);
      if (!arg) {
        continue;
      }
      const argKind = arg.kind();
      if (argKind !== 'identifier' && argKind !== 'literalNumber' && argKind !== 'literalString') {
        continue;
      }

      const startLine = call.range().start.line + 1;
      const endLine = call.range().end.line + 1;
      violations.push({
        id: `redundant-cast:L${startLine}:${name}`,
        lines: { start: startLine, end: endLine },
        description: `Redundant ${name}() cast at line ${startLine}`,
        text: call.text(),
      });
    }

    return violations;
  },

  remove(source: string, violation: Violation): string | null {
    const root = parseCached('pascal', source);
    const calls = root.root().findAll({ rule: { kind: 'exprCall' } });

    for (const call of calls) {
      const startLine = call.range().start.line + 1;
      if (startLine !== violation.lines.start) {
        continue;
      }

      const nameNode = call.children()[0];
      if (!nameNode || nameNode.kind() !== 'identifier') {
        continue;
      }
      const name = nameNode.text().toLowerCase();
      if (!CAST_NAMES.has(name)) {
        continue;
      }

      const arg = getSingleArg(call);
      if (!arg) {
        continue;
      }

      const start = call.range().start.index;
      const end = call.range().end.index;
      return source.slice(0, start) + arg.text() + source.slice(end);
    }

    return null;
  },
};
