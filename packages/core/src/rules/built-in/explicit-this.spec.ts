import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLanguageRegistered } from '~/parser.js';

import { makeRuleCtx } from '../test-utils.js';
import { explicitThis } from './explicit-this.js';

describe('explicit-this', () => {
  beforeAll(() => {
    ensureLanguageRegistered('cpp');
  });

  it('adds explicit this-> to a member access', () => {
    const result = explicitThis.apply(
      makeRuleCtx(`void Foo::bar() { x = 1; }`, { language: 'cpp', functionName: 'bar' }),
    );
    expect(result).not.toBeNull();
    expect(result!.source).toBe('void Foo::bar() { this->x = 1; }');
  });
});
