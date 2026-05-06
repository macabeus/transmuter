import { describe, expect, it } from 'vitest';
import { parse } from '~/parser.js';

import { countSmells } from './smell.js';

describe('countSmells', () => {
  it('returns zero for clean code', () => {
    const source = `int foo() { int x = 1; return x; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.tempVariables).toBe(0);
    expect(result.doWhileZero).toBe(0);
  });

  it('counts temp variables (_tNNN pattern)', () => {
    const source = `int foo() { int _t1 = 0; int _t23 = 1; int normal = 2; return normal; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.tempVariables).toBe(2);
  });

  it('counts cast expressions', () => {
    const source = `int foo(short a) { return (int)((short)a + (int)1); }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.casts).toBe(3);
  });

  it('counts do-while(0) blocks', () => {
    const source = `void foo() { do { int x = 1; } while(0); do { int y = 2; } while(0); }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.doWhileZero).toBe(2);
  });

  it('does not count do-while with non-zero condition', () => {
    const source = `void foo() { int x = 1; do { x--; } while(x); }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.doWhileZero).toBe(0);
  });

  it('counts single-use variables', () => {
    const source = `int foo() { int x = 1; return x; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.singleUseVariables).toBe(1);
  });

  it('does not count multi-use variables as single-use', () => {
    const source = `int foo() { int x = 1; x = x + 1; return x; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.singleUseVariables).toBe(0);
  });

  it('counts total statements', () => {
    const source = `void foo() { int x = 1; x = x + 1; if (x > 0) { x = 0; } return; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    // 4 statements in outer block + 1 in if block
    expect(result.statementCount).toBe(5);
  });

  it('returns zero for nonexistent function', () => {
    const source = `int bar() { return 0; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.total).toBe(0);
  });

  it('computes weighted total', () => {
    // 1 temp var (10) + 1 do-while(0) (10) + 2 casts (6) + statements
    const source = `int foo(short a) { int _t1 = (int)a; do { _t1 = (int)a; } while(0); return _t1; }`;
    const root = parse('c', source);
    const result = countSmells(root, 'foo');

    expect(result.tempVariables).toBe(1);
    expect(result.doWhileZero).toBe(1);
    expect(result.casts).toBe(2);
    expect(result.total).toBeGreaterThan(0);
    // total = 1*10 + 1*10 + 2*3 + singleUse*5 + statements*1
    expect(result.total).toBe(
      result.tempVariables * 10 +
        result.doWhileZero * 10 +
        result.casts * 3 +
        result.singleUseVariables * 5 +
        result.statementCount,
    );
  });

  it('handles the fixed-mul8 ugly output', () => {
    const source = `s16 FixedMul8(s16 a, s16 b) {
    s32 result = (s32)a * (s32)b;
    int _t533 = 0 > result;
                s32 shifted = result;
int _t267 = _t533;
do {
    if (_t267)
        shifted += 0xFF;
} while(0);
    return (s16)(shifted >> 8);
}`;
    const root = parse('c', source);
    const result = countSmells(root, 'FixedMul8');

    expect(result.tempVariables).toBe(2); // _t533, _t267
    expect(result.doWhileZero).toBe(1);
    expect(result.casts).toBeGreaterThan(0); // (s32)a, (s32)b, (s16)(...)
    expect(result.total).toBeGreaterThan(30); // Significant smells
  });

  it('scores clean code lower than ugly code', () => {
    const ugly = `s16 FixedMul8(s16 a, s16 b) {
    s32 result = (s32)a * (s32)b;
    int _t533 = 0 > result;
                s32 shifted = result;
int _t267 = _t533;
do {
    if (_t267)
        shifted += 0xFF;
} while(0);
    return (s16)(shifted >> 8);
}`;
    const clean = `s16 FixedMul8(s16 a, s16 b) {
    s32 r = a * b;
    return r /= 256;
}`;
    const uglySmell = countSmells(parse('c', ugly), 'FixedMul8');
    const cleanSmell = countSmells(parse('c', clean), 'FixedMul8');

    expect(cleanSmell.total).toBeLessThan(uglySmell.total);
  });
});
