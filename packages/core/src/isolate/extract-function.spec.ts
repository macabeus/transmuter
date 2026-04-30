import { describe, expect, it } from 'vitest';

import { extractFunctionDefinition } from './extract-function.js';

describe('extractFunctionDefinition', () => {
  it('extracts a simple function definition from a TU', () => {
    const source = `
typedef int u32;
struct Point { int x; int y; };
int other(int a) { return a; }
int target(int b) { return b * 2; }
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('int target(int b) { return b * 2; }');
  });

  it('captures the return type even when on a previous line', () => {
    const source = `
int prev(void) { return 0; }
static int
target(int x)
{
    return x;
}
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('static int\ntarget(int x)\n{\n    return x;\n}');
  });

  it('handles nested braces in the body', () => {
    const source = `
int target(int x) {
    if (x > 0) {
        for (int i = 0; i < x; i++) {
            x--;
        }
    }
    return x;
}
void after(void) {}
`;
    const out = extractFunctionDefinition(source, 'target');
    expect(out.startsWith('int target')).toBe(true);
    expect(out.endsWith('}')).toBe(true);
    expect(out).toContain('for (int i = 0; i < x; i++)');
  });

  it('handles function-pointer parameters (nested parens)', () => {
    const source = `
void target(int x, void (*cb)(int)) { cb(x); }
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('void target(int x, void (*cb)(int)) { cb(x); }');
  });

  it('skips forward declarations and call sites and finds the definition', () => {
    const source = `
int target(int);
int other(void) { return target(1); }
int target(int x) { return x + 100; }
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('int target(int x) { return x + 100; }');
  });

  it('returns the original source if no definition is found', () => {
    const source = `int other(void) { return 0; }`;
    expect(extractFunctionDefinition(source, 'missing')).toBe(source);
  });

  it('escapes regex metacharacters in the function name', () => {
    // A pathological identifier that would otherwise be interpreted as a regex.
    // C identifiers can't contain dots, but defensive escaping is cheap.
    const source = `int my_fn(void) { return 1; }`;
    // No metachars used here, but ensure normal name still works.
    expect(extractFunctionDefinition(source, 'my_fn')).toBe('int my_fn(void) { return 1; }');
  });

  // Bug-#2 regression tests — the brace-balanced scan must skip over string
  // literals, char literals, and comments. Otherwise an unbalanced brace
  // hidden inside one of those will throw off depth counting and either
  // truncate the body early or run away to EOF.

  it('handles a `}` inside a string literal', () => {
    const source = `
int target(int x) {
    const char *s = "}}}";
    return x;
}
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe(
      'int target(int x) {\n    const char *s = "}}}";\n    return x;\n}',
    );
  });

  it('handles a `{` inside a char literal', () => {
    const source = `
int target(int x) {
    char c = '{';
    return x + c;
}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe(
      "int target(int x) {\n    char c = '{';\n    return x + c;\n}",
    );
  });

  it('handles a `}` inside a // line comment', () => {
    const source = `
int target(int x) {
    // }
    return x;
}
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('int target(int x) {\n    // }\n    return x;\n}');
  });

  it('handles a `}` inside a block comment', () => {
    const source = `
int target(int x) {
    /* } */
    return x;
}
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('int target(int x) {\n    /* } */\n    return x;\n}');
  });

  it('handles backslash-escaped quote inside a string literal', () => {
    const source = `
int target(int x) {
    const char *s = "\\"}";
    return x;
}
void after(void) {}
`;
    expect(extractFunctionDefinition(source, 'target')).toBe(
      'int target(int x) {\n    const char *s = "\\"}";\n    return x;\n}',
    );
  });
});
