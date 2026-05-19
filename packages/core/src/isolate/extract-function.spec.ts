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
    expect(extractFunctionDefinition(source, 'target')).toBe(
      'int target(int x) {\n    if (x > 0) {\n        for (int i = 0; i < x; i++) {\n            x--;\n        }\n    }\n    return x;\n}',
    );
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

  it('ignores a fake definition inside a doc comment before the real one', () => {
    const source = `
/**
 * Example call:
 *   target(int a) {
 *     return a;
 *   }
 */
int target(int x) { return x + 1; }
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('int target(int x) { return x + 1; }');
  });

  it('ignores a fake definition inside a string literal before the real one', () => {
    const source = `
const char *help = "target(int a) { return a; }";
int target(int x) { return x + 1; }
`;
    expect(extractFunctionDefinition(source, 'target')).toBe('int target(int x) { return x + 1; }');
  });
});
