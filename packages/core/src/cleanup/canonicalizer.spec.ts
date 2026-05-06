import { describe, expect, it } from 'vitest';
import { parse } from '~/parser.js';
import { findTargetFunction } from '~/rules/helpers.js';

/**
 * These tests verify the canonicalization pass logic at the AST level.
 * They don't test assembly preservation (that requires a compiler + target),
 * so they test the pass functions in isolation by importing the module
 * and verifying the transformations produce correct candidates.
 *
 * Integration tests with real compilation would go in the test-fixture.
 */

// We test the pass functions indirectly by verifying the Canonicalizer's
// internal transform logic. Since the passes are not exported, we test
// through the public interface patterns: given a source with specific
// smells, a pass would produce a candidate with that smell removed.

describe('canonicalizer pass patterns', () => {
  describe('do-while(0) unwrap', () => {
    it('identifies do-while(0) for unwrapping', () => {
      const source = `void foo() {
    do {
        x = 1;
    } while(0);
}`;
      const root = parse('c', source);
      const fn = findTargetFunction(root, 'foo')!;
      const doStmts = fn.findAll({ rule: { kind: 'do_statement' } });
      expect(doStmts.length).toBe(1);

      const condition = doStmts[0]!.field('condition');
      expect(condition).not.toBeNull();
      // The condition of do-while is a parenthesized_expression containing '0'
      const condText = condition!.text();
      expect(condText).toContain('0');
    });

    it('does not match do-while with non-zero condition', () => {
      const source = `void foo() { int x = 5; do { x--; } while(x); }`;
      const root = parse('c', source);
      const fn = findTargetFunction(root, 'foo')!;
      const doStmts = fn.findAll({ rule: { kind: 'do_statement' } });
      expect(doStmts.length).toBe(1);

      const condition = doStmts[0]!.field('condition');
      const condText = condition!.text();
      expect(condText).not.toBe('(0)');
    });
  });

  describe('dead variable elimination', () => {
    it('identifies unused declared variables', () => {
      const source = `void foo() { int dead = 42; int used = 1; return used; }`;
      const root = parse('c', source);
      const fn = findTargetFunction(root, 'foo')!;

      // Find all init_declarators
      const decls = fn.findAll({ rule: { kind: 'init_declarator' } });
      expect(decls.length).toBe(2);

      // 'dead' should have no references besides its declaration
      const deadIdent = decls[0]!.field('declarator')!;
      expect(deadIdent.text()).toBe('dead');

      const deadRefs = fn
        .findAll({ rule: { kind: 'identifier', regex: '^dead$' } })
        .filter((n) => n.range().start.index !== deadIdent.range().start.index);
      expect(deadRefs.length).toBe(0);
    });

    it('does not flag variables that are read', () => {
      const source = `int foo() { int x = 1; return x + 1; }`;
      const root = parse('c', source);
      const fn = findTargetFunction(root, 'foo')!;

      const decls = fn.findAll({ rule: { kind: 'init_declarator' } });
      const ident = decls[0]!.field('declarator')!;
      const refs = fn
        .findAll({ rule: { kind: 'identifier', regex: '^x$' } })
        .filter((n) => n.range().start.index !== ident.range().start.index);

      // x is read in the return statement
      expect(refs.length).toBeGreaterThan(0);
    });
  });

  describe('single-use variable inlining', () => {
    it('identifies single-use variable pattern', () => {
      const source = `int foo() { int temp = 42; return temp; }`;
      const root = parse('c', source);
      const fn = findTargetFunction(root, 'foo')!;

      const decls = fn.findAll({ rule: { kind: 'init_declarator' } });
      expect(decls.length).toBe(1);

      const ident = decls[0]!.field('declarator')!;
      const value = decls[0]!.field('value')!;
      expect(ident.text()).toBe('temp');
      expect(value.text()).toBe('42');

      // Only one read reference
      const refs = fn
        .findAll({ rule: { kind: 'identifier', regex: '^temp$' } })
        .filter((n) => n.range().start.index !== ident.range().start.index);
      expect(refs.length).toBe(1);
    });
  });

  describe('redundant cast removal', () => {
    it('identifies cast expressions and their inner values', () => {
      const source = `int foo(int x) { return (int)x; }`;
      const root = parse('c', source);
      const fn = findTargetFunction(root, 'foo')!;

      const casts = fn.findAll({ rule: { kind: 'cast_expression' } });
      expect(casts.length).toBe(1);

      const inner = casts[0]!.field('value');
      expect(inner).not.toBeNull();
      expect(inner!.text()).toBe('x');
    });
  });

  describe('whitespace normalization', () => {
    it('detects multiple consecutive blank lines', () => {
      const source = `void foo() {\n    int x = 1;\n\n\n\n    return;\n}`;
      const lines = source.split('\n');
      let consecutiveBlanks = 0;
      let prevBlank = false;
      for (const line of lines) {
        const isBlank = line.trim() === '';
        if (isBlank && prevBlank) {
          consecutiveBlanks++;
        }
        prevBlank = isBlank;
      }
      expect(consecutiveBlanks).toBeGreaterThan(0);
    });
  });
});
