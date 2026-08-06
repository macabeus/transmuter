import { describe, expect, it } from 'vitest';

import { makeRuleCtx } from '../test-utils.js';
import { tempForExpr } from './temp-for-expr.js';

describe('temp-for-expr', () => {
  it('extracts a sub-expression into a temporary variable', () => {
    const result = tempForExpr.apply(makeRuleCtx(`void foo() {\n  int a = 1 + 2;\n}`));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('void foo() {\n  int _t0 = 1 + 2;\n  int a = _t0;\n}');
  });

  // C89 (agbcc et al.) rejects a declaration that follows a statement in the same block, so
  // a temp extracted at a statement position gets its own wrapping block rather than being
  // dropped in mid-block. Before this, the rule's output could not be compiled at all by the
  // very profiles it exists to serve.
  it('wraps a statement rather than emitting a mid-block declaration', () => {
    const result = tempForExpr.apply(makeRuleCtx(`void foo() {\n  bar();\n  baz(1 + 2);\n}`));
    expect(result).not.toBeNull();
    expect(result!.source).not.toMatch(/baz\(1 \+ 2\)/);
    const body = result!.source;
    const declLine = body.split('\n').findIndex((l) => /int _t\d+ =/.test(l));
    expect(declLine).toBeGreaterThan(-1);
    // the declaration must open a block, i.e. the line before it ends with `{`
    expect(body.split('\n')[declLine - 1]!.trimEnd().endsWith('{')).toBe(true);
  });

  // Inserting before a declaration is legal only while nothing but declarations precede it.
  it('declines when a statement already precedes the declaration it would extract from', () => {
    const result = tempForExpr.apply(makeRuleCtx(`void foo() {\n  bar();\n  int a = 1 + 2;\n}`));
    if (result) {
      expect(result.source).not.toMatch(/bar\(\);\n\s*int _t\d+ =/);
    }
  });
});
