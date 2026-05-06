import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLanguageRegistered } from '~/parser.js';

import { noCStyleCast } from './no-c-style-cast.js';

describe('no-c-style-cast', () => {
  beforeAll(() => {
    ensureLanguageRegistered('cpp');
  });

  describe('simple cast of an identifier', () => {
    const source = `void foo() {
  int x = (int)y;
}`;

    it('detects the C-style cast as a violation', () => {
      const violations = noCStyleCast.detect(source, 'foo');
      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        id: 'c-cast:L2:C11',
        lines: { start: 2, end: 2 },
        description: 'C-style cast at line 2:11',
        text: '(int)y',
      });
    });

    it('strips the cast and keeps the inner expression', () => {
      const [violation] = noCStyleCast.detect(source, 'foo');
      expect(violation).toBeDefined();
      const result = noCStyleCast.remove(source, violation!);
      expect(result).toBe(`void foo() {
  int x = y;
}`);
    });
  });

  describe('cast wrapping a parenthesized expression', () => {
    const source = `void foo() {
  int x = (int)(a + b);
}`;

    it('unwraps the parenthesized expression after stripping the cast', () => {
      const [violation] = noCStyleCast.detect(source, 'foo');
      expect(violation).toBeDefined();
      const result = noCStyleCast.remove(source, violation!);
      expect(result).toBe(`void foo() {
  int x = a + b;
}`);
    });
  });

  describe('multiple casts on the same line', () => {
    const source = `void foo() {
  int x = (int)a + (int)b;
}`;

    it('detects each cast separately', () => {
      const violations = noCStyleCast.detect(source, 'foo');
      expect(violations).toHaveLength(2);
      expect(violations.map((v) => v.text)).toEqual(['(int)a', '(int)b']);
    });
  });

  describe('no violations', () => {
    it('returns an empty list when there are no casts', () => {
      const source = `void foo() {
  int x = a + b;
}`;
      const violations = noCStyleCast.detect(source, 'foo');
      expect(violations).toHaveLength(0);
    });

    it('returns an empty list when the target function is not present', () => {
      const source = `void bar() {
  int x = (int)y;
}`;
      const violations = noCStyleCast.detect(source, 'foo');
      expect(violations).toHaveLength(0);
    });
  });
});
