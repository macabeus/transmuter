import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLanguageRegistered } from '~/parser.js';

import { makeRuleCtx } from '../test-utils.js';
import { castStyleSwap } from './cast-style-swap.js';

describe('cast-style-swap', () => {
  beforeAll(() => {
    ensureLanguageRegistered('cpp');
  });

  it('converts C-style cast to static_cast', () => {
    const result = castStyleSwap.apply(makeRuleCtx(`void foo() { int x = (int)y; }`, { language: 'cpp' }));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('void foo() { int x = static_cast<int>(y); }');
  });
});
