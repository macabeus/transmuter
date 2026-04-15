import { describe, expect, it } from 'vitest';

import { isolateFunction } from './isolate.js';

describe('isolateFunction', () => {
  it('keeps the target function body intact', () => {
    const source = `
int other(int x) { return x + 1; }
int target(int a, int b) { return a * b; }
int more(void) { return 0; }
`;
    const { source: out } = isolateFunction(source, 'target');

    expect(out).toContain('int target(int a, int b) { return a * b; }');
  });

  it('strips non-target, non-inline function bodies to declarations', () => {
    const source = `
int other(int x) { return x + 1; }
int target(void) { return 42; }
`;
    const { source: out, bodiesStripped } = isolateFunction(source, 'target');

    expect(bodiesStripped).toBe(1);
    expect(out).toContain('int other(int x);');
    expect(out).not.toContain('return x + 1');
    expect(out).toContain('int target(void) { return 42; }');
  });

  it('preserves static inline function bodies (they may inline into target)', () => {
    const source = `
static inline int helper(int x) { return x * 2; }
int target(int y) { return helper(y); }
`;
    const { source: out, bodiesStripped } = isolateFunction(source, 'target');

    expect(bodiesStripped).toBe(0);
    expect(out).toContain('static inline int helper(int x) { return x * 2; }');
  });

  it('preserves plain inline function bodies', () => {
    const source = `
inline int helper(int x) { return x * 2; }
int target(int y) { return helper(y); }
`;
    const { source: out } = isolateFunction(source, 'target');

    expect(out).toContain('inline int helper(int x) { return x * 2; }');
  });

  it('preserves #define directives (inline functions may depend on them)', () => {
    const source = `
#define FOO 1
#define BAR(x) ((x) + 1)
int target(void) { return 0; }
`;
    const { source: out } = isolateFunction(source, 'target');

    expect(out).toContain('#define FOO 1');
    expect(out).toContain('#define BAR(x) ((x) + 1)');
    expect(out).toContain('int target(void) { return 0; }');
  });

  it('preserves typedefs, struct, and enum declarations', () => {
    const source = `
typedef unsigned int u32;
struct point { int x; int y; };
enum color { RED, GREEN, BLUE };
int target(u32 n) { return (int) n; }
`;
    const { source: out } = isolateFunction(source, 'target');

    expect(out).toContain('typedef unsigned int u32;');
    expect(out).toContain('struct point { int x; int y; };');
    expect(out).toContain('enum color { RED, GREEN, BLUE };');
    expect(out).toContain('int target(u32 n) { return (int) n; }');
  });

  it('preserves global variable declarations', () => {
    const source = `
int global_state = 0;
extern int external_state;
int target(void) { return global_state + external_state; }
`;
    const { source: out } = isolateFunction(source, 'target');

    expect(out).toContain('int global_state = 0;');
    expect(out).toContain('extern int external_state;');
  });

  it('throws when the target function is not found', () => {
    const source = `int foo(void) { return 0; }`;
    expect(() => isolateFunction(source, 'missing')).toThrow(/target function 'missing' not found/);
  });

  it('handles multiple non-inline strips without index drift', () => {
    const source = `
int a(void) { return 1; }
int b(void) { return 2; }
int c(void) { return 3; }
int target(void) { return a() + b() + c(); }
`;
    const { source: out, bodiesStripped } = isolateFunction(source, 'target');

    expect(bodiesStripped).toBe(3);
    expect(out).toContain('int a(void);');
    expect(out).toContain('int b(void);');
    expect(out).toContain('int c(void);');
    expect(out).toContain('int target(void) { return a() + b() + c(); }');
  });
});
