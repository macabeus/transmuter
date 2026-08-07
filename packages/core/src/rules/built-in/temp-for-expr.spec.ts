import { describe, expect, it } from 'vitest';

import { makeRuleCtx } from '../test-utils.js';
import { tempForExpr } from './temp-for-expr.js';

describe('temp-for-expr', () => {
  it('extracts a sub-expression into a temporary variable', () => {
    const result = tempForExpr.apply(makeRuleCtx(`void foo() {\n  int a = 1 + 2;\n}`));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('void foo() {\n  int _t0 = 1 + 2;\n  int a = _t0;\n}');
  });

  // Every profile this tool ships is C89, so a temp declared in front of a statement that is
  // not itself in the block's declaration prefix is source the compiler rejects.
  it('wraps a non-declaration statement in a block instead of declaring mid-block', () => {
    const result = tempForExpr.apply(makeRuleCtx(`void foo() {\n  int a;\n  a = 1 + 2;\n}`));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('void foo() {\n  int a;\n  {\n      int _t0 = 1 + 2;\n      a = _t0;\n  }\n}');
  });

  it('declines a declaration that statements already precede, rather than emitting illegal C', () => {
    // `int b = 1 + 2;` is a declaration, but a statement precedes it, so inserting before it
    // would leave a declaration after a statement -- still illegal in C89.
    const result = tempForExpr.apply(makeRuleCtx(`void foo() {\n  int a;\n  a = 0;\n  int b = 1 + 2;\n}`));
    expect(result).toBeNull();
  });
});
