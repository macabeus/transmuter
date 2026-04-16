/**
 * Rule: pascal-loop-swap
 *
 * Transform loop constructs:
 * - Wrap a while loop body in an extra begin/end
 * - Convert `while true do begin ... end` to `repeat ... until false`
 */
import type { DiffType, MutationApplyResult } from '~/types.js';

import { findAllByKind, findTargetFunction, getIndentation, replaceRange } from '../helpers.js';
import { getPascalStatements } from '../pascal-helpers.js';
import type { MutationContext, Rule } from '../rule.js';

export const pascalLoopSwap: Rule = {
  id: 'pascal-loop-swap',
  description: 'Transform between while/repeat loop constructs.',
  languages: ['pascal'],
  defaultWeight: 10,
  relevantDiffTypes: new Set<DiffType>(['opMismatch', 'insert', 'delete']),

  apply(ctx: MutationContext): MutationApplyResult | null {
    const { source, root, rng, functionName } = ctx;
    const fn = findTargetFunction(root, functionName, 'pascal');
    if (!fn) {
      return null;
    }

    const whileNodes = findAllByKind(fn, 'while');
    const repeatNodes = findAllByKind(fn, 'repeat');

    // Try while true -> repeat until false
    const whileTrueCandidates = whileNodes.filter((n) => {
      const children = n.children();
      // Look for `while true do ...` — `true` appears as kTrue or identifier
      const condChild = children.find((c) => c.kind() === 'identifier' || c.kind() === 'kTrue');
      return condChild !== null && condChild !== undefined && condChild.text().toLowerCase() === 'true';
    });

    // Try repeat until false -> while true
    const repeatFalseCandidates = repeatNodes.filter((n) => {
      const children = n.children();
      // The condition is after `until` — `false` appears as kFalse or identifier
      const lastChild = children[children.length - 1];
      return (
        lastChild !== undefined &&
        (lastChild.kind() === 'identifier' || lastChild.kind() === 'kFalse') &&
        lastChild.text().toLowerCase() === 'false'
      );
    });

    const allCandidates = [
      ...whileTrueCandidates.map((n) => ({ node: n, kind: 'while-to-repeat' as const })),
      ...repeatFalseCandidates.map((n) => ({ node: n, kind: 'repeat-to-while' as const })),
    ];

    if (allCandidates.length === 0) {
      return null;
    }

    const picked = rng.pick(allCandidates);
    const node = picked.node;
    const range = node.range();
    const indent = getIndentation(source, node);

    if (picked.kind === 'while-to-repeat') {
      // Extract the body (block)
      const body = node.find({ rule: { kind: 'block' } });
      if (!body) {
        return null;
      }
      const stmts = getPascalStatements(body);
      const bodyText = stmts.map((s) => `${indent}  ${s.text()}`).join(';\n');
      const replacement = `repeat\n${bodyText}\n${indent}until false`;

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    } else {
      // repeat ... until false -> while true do begin ... end
      const children = node.children();
      // Statements are between kRepeat and kUntil
      const repeatIdx = children.findIndex((c) => c.kind() === 'kRepeat');
      const untilIdx = children.findIndex((c) => c.kind() === 'kUntil');
      if (repeatIdx < 0 || untilIdx < 0) {
        return null;
      }
      const bodyChildren = children.slice(repeatIdx + 1, untilIdx).filter((c) => {
        const kind = c.kind();
        return kind !== ';' && kind !== 'comment' && kind !== 'line_comment';
      });
      const bodyText = bodyChildren.map((s) => `${indent}  ${s.text()}`).join(';\n');
      const replacement = `while true do\n${indent}begin\n${bodyText};\n${indent}end`;

      return {
        source: replaceRange(source, range.start.index, range.end.index, replacement),
        location: { line: range.start.line + 1, column: range.start.column + 1 },
      };
    }
  },
};
