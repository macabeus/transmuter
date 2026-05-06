import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLanguageRegistered } from '~/parser.js';

import { makeRuleCtx } from '../test-utils.js';
import { reorderFieldInit } from './reorder-field-init.js';

describe('reorder-field-init', () => {
  beforeAll(() => {
    ensureLanguageRegistered('cpp');
  });

  it('swaps two adjacent field initializers', () => {
    const source = `class Foo {\n  int a, b, c;\n  Foo() : a(1), b(2), c(3) {}\n};`;
    const result = reorderFieldInit.apply(makeRuleCtx(source, { language: 'cpp', functionName: 'Foo' }));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('class Foo {\n  int a, b, c;\n  Foo() : b(2), a(1), c(3) {}\n};');
  });
});
