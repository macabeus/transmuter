import { describe, expect, it } from 'vitest';
import { parse } from '~/parser.js';

import {
  escapeRegex,
  findTargetFunction,
  getDeclarations,
  getIndentation,
  getStatements,
  isInsideAsm,
  replaceRange,
  swapRanges,
} from './helpers.js';

// ---------------------------------------------------------------------------
// findTargetFunction
// ---------------------------------------------------------------------------

describe('findTargetFunction', () => {
  it('finds a C function by name', () => {
    const root = parse('c', 'int foo(void) { return 1; }');
    const node = findTargetFunction(root, 'foo');
    expect(node).not.toBeNull();
    expect(node!.kind()).toBe('function_definition');
  });

  it('returns null when function is not found', () => {
    const root = parse('c', 'int foo(void) { return 1; }');
    expect(findTargetFunction(root, 'bar')).toBeNull();
  });

  it('finds the correct function among multiple', () => {
    const source = `
int foo(void) { return 1; }
int bar(void) { return 2; }
int baz(void) { return 3; }
`;
    const root = parse('c', source);
    const node = findTargetFunction(root, 'bar');
    expect(node).not.toBeNull();
    expect(node!.text()).toContain('return 2');
  });

  it('does not match partial function names', () => {
    const source = 'int foobar(void) { return 1; }';
    const root = parse('c', source);
    expect(findTargetFunction(root, 'foo')).toBeNull();
  });

  it('handles function names with special regex characters', () => {
    // Unlikely in practice, but escapeRegex should prevent injection
    const root = parse('c', 'int normal(void) { return 1; }');
    expect(findTargetFunction(root, 'foo.*bar')).toBeNull();
  });

  it('finds function in source with preprocessor and globals', () => {
    const source = `
int global_var = 0;
typedef unsigned int u32;
void target(int x) {
  global_var = x;
}
`;
    const root = parse('c', source);
    const node = findTargetFunction(root, 'target');
    expect(node).not.toBeNull();
    expect(node!.text()).toContain('global_var = x');
  });
});

// ---------------------------------------------------------------------------
// isInsideAsm
// ---------------------------------------------------------------------------

describe('isInsideAsm', () => {
  it('returns false for a regular statement', () => {
    const source = 'void foo(void) { int a = 1; }';
    const root = parse('c', source);
    const decl = root.root().find({ rule: { kind: 'declaration' } });
    expect(decl).not.toBeNull();
    expect(isInsideAsm(decl!)).toBe(false);
  });

  it('returns true for a node inside gnu_asm_expression', () => {
    const source = 'void foo(void) { asm("nop"); }';
    const root = parse('c', source);
    const asmNode = root.root().find({ rule: { kind: 'gnu_asm_expression' } });
    if (asmNode) {
      // Find a child inside the asm
      const child = asmNode.children()[0];
      if (child) {
        expect(isInsideAsm(child)).toBe(true);
      }
    }
    // The asm expression itself should also return true
    if (asmNode) {
      expect(isInsideAsm(asmNode)).toBe(true);
    }
  });

  it('returns false for a node that is a sibling of asm', () => {
    const source = `void foo(void) {
  int a = 1;
  asm("nop");
  int b = 2;
}`;
    const root = parse('c', source);
    const decls = root.root().findAll({ rule: { kind: 'declaration' } });
    for (const decl of decls) {
      expect(isInsideAsm(decl)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// getStatements
// ---------------------------------------------------------------------------

describe('getStatements', () => {
  it('returns statements excluding braces and comments', () => {
    const source = `void foo(void) {
  int a = 1;
  a = 2;
  return;
}`;
    const root = parse('c', source);
    const fn = findTargetFunction(root, 'foo')!;
    const body = fn.find({ rule: { kind: 'compound_statement' } })!;
    const stmts = getStatements(body);

    expect(stmts.length).toBe(3);
    expect(stmts.every((s) => s.kind() !== '{' && s.kind() !== '}')).toBe(true);
  });

  it('excludes comments', () => {
    const source = `void foo(void) {
  // this is a comment
  int a = 1;
  /* block comment */
  a = 2;
}`;
    const root = parse('c', source);
    const fn = findTargetFunction(root, 'foo')!;
    const body = fn.find({ rule: { kind: 'compound_statement' } })!;
    const stmts = getStatements(body);

    expect(stmts.every((s) => s.kind() !== 'comment')).toBe(true);
  });

  it('returns empty array for empty function body', () => {
    const source = 'void foo(void) {}';
    const root = parse('c', source);
    const fn = findTargetFunction(root, 'foo')!;
    const body = fn.find({ rule: { kind: 'compound_statement' } })!;
    const stmts = getStatements(body);

    expect(stmts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getDeclarations
// ---------------------------------------------------------------------------

describe('getDeclarations', () => {
  it('returns only declaration nodes', () => {
    const source = `void foo(void) {
  int a = 1;
  int b = 2;
  a = b;
  return;
}`;
    const root = parse('c', source);
    const fn = findTargetFunction(root, 'foo')!;
    const body = fn.find({ rule: { kind: 'compound_statement' } })!;
    const decls = getDeclarations(body);

    expect(decls.length).toBe(2);
    expect(decls.every((d) => d.kind() === 'declaration')).toBe(true);
  });

  it('returns empty array when no declarations exist', () => {
    const source = `void foo(int a) {
  a = 1;
  return;
}`;
    const root = parse('c', source);
    const fn = findTargetFunction(root, 'foo')!;
    const body = fn.find({ rule: { kind: 'compound_statement' } })!;
    const decls = getDeclarations(body);

    expect(decls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replaceRange
// ---------------------------------------------------------------------------

describe('replaceRange', () => {
  it('replaces a range in the middle of a string', () => {
    expect(replaceRange('abcdef', 2, 4, 'XY')).toBe('abXYef');
  });

  it('replaces at the start', () => {
    expect(replaceRange('abcdef', 0, 3, 'Z')).toBe('Zdef');
  });

  it('replaces at the end', () => {
    expect(replaceRange('abcdef', 4, 6, 'ZZ')).toBe('abcdZZ');
  });

  it('inserts when replacement is longer than range', () => {
    expect(replaceRange('ab', 1, 1, 'XYZ')).toBe('aXYZb');
  });

  it('deletes when replacement is empty', () => {
    expect(replaceRange('abcdef', 2, 4, '')).toBe('abef');
  });

  it('replaces entire string', () => {
    expect(replaceRange('abc', 0, 3, 'XYZ')).toBe('XYZ');
  });
});

// ---------------------------------------------------------------------------
// swapRanges
// ---------------------------------------------------------------------------

describe('swapRanges', () => {
  it('swaps two non-overlapping ranges', () => {
    //              0123456789
    const source = 'AABBCCDDEE';
    // Swap AA (0-2) and CC (4-6)
    expect(swapRanges(source, 0, 2, 4, 6)).toBe('CCBBAADDEE');
  });

  it('swaps adjacent ranges', () => {
    const source = 'AABB';
    expect(swapRanges(source, 0, 2, 2, 4)).toBe('BBAA');
  });

  it('handles reversed argument order (B before A)', () => {
    const source = 'AABBCCDDEE';
    // Pass B range first — should auto-correct
    expect(swapRanges(source, 4, 6, 0, 2)).toBe('CCBBAADDEE');
  });

  it('swaps ranges of different lengths', () => {
    const source = 'XXX__Y';
    // Swap XXX (0-3) and Y (5-6)
    expect(swapRanges(source, 0, 3, 5, 6)).toBe('Y__XXX');
  });

  it('preserves text between ranges', () => {
    const source = 'A---B';
    expect(swapRanges(source, 0, 1, 4, 5)).toBe('B---A');
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('foo.bar')).toBe('foo\\.bar');
    expect(escapeRegex('a+b')).toBe('a\\+b');
    expect(escapeRegex('a*b')).toBe('a\\*b');
    expect(escapeRegex('a?b')).toBe('a\\?b');
    expect(escapeRegex('a[b]')).toBe('a\\[b\\]');
    expect(escapeRegex('a(b)')).toBe('a\\(b\\)');
    expect(escapeRegex('a{b}')).toBe('a\\{b\\}');
    expect(escapeRegex('a^b$c')).toBe('a\\^b\\$c');
    expect(escapeRegex('a|b')).toBe('a\\|b');
    expect(escapeRegex('a\\b')).toBe('a\\\\b');
  });

  it('leaves normal strings unchanged', () => {
    expect(escapeRegex('foo')).toBe('foo');
    expect(escapeRegex('hello_world')).toBe('hello_world');
    expect(escapeRegex('CamelCase123')).toBe('CamelCase123');
  });

  it('handles empty string', () => {
    expect(escapeRegex('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getIndentation
// ---------------------------------------------------------------------------

describe('getIndentation', () => {
  it('returns indentation for a 2-space indented node', () => {
    const source = `void foo(void) {\n  int a = 1;\n}`;
    const root = parse('c', source);
    const decl = root.root().find({ rule: { kind: 'declaration' } })!;
    expect(getIndentation(source, decl)).toBe('  ');
  });

  it('returns indentation for a 4-space indented node', () => {
    const source = `void foo(void) {\n    int a = 1;\n}`;
    const root = parse('c', source);
    const decl = root.root().find({ rule: { kind: 'declaration' } })!;
    expect(getIndentation(source, decl)).toBe('    ');
  });

  it('returns indentation for a tab-indented node', () => {
    const source = `void foo(void) {\n\tint a = 1;\n}`;
    const root = parse('c', source);
    const decl = root.root().find({ rule: { kind: 'declaration' } })!;
    expect(getIndentation(source, decl)).toBe('\t');
  });

  it('returns empty string for a node with no indentation', () => {
    const source = 'int a = 1;';
    const root = parse('c', source);
    const decl = root.root().find({ rule: { kind: 'declaration' } })!;
    expect(getIndentation(source, decl)).toBe('');
  });

  it('returns empty string for a node at the start of the file', () => {
    const source = 'void foo(void) {}';
    const root = parse('c', source);
    const fn = findTargetFunction(root, 'foo')!;
    expect(getIndentation(source, fn)).toBe('');
  });
});
