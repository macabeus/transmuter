import { DecompYamlError, type LoadedConfig, parseDecompYaml } from '@match-kit/decomp-yaml';
import { describe, expect, it } from 'vitest';

import { transmuterBlock } from './config.js';

const loaded = (text: string): LoadedConfig => ({
  path: '/p/decomp.yaml',
  dir: '/p',
  config: parseDecompYaml(text, '/p/decomp.yaml'),
});

describe('transmuterBlock', () => {
  it('reads every setting of tools.transmuter', () => {
    const config = loaded(
      [
        'tools:',
        '  transmuter:',
        '    compiler: cc -c {{inputPath}} -o {{outputPath}}',
        '    profile: agbcc',
        '    concurrency: 4',
        '    maxCompiles: 500',
        '    timeoutMs: 60000',
        '    noReduce: true',
        '    isolate: false',
        '    ruleWeights: { swap-operands: 2 }',
        '    disabledRules: [reorder-decls]',
        '    diffSettings: { functionRelocDiffs: none }',
        '    mutationDepth: 3',
      ].join('\n'),
    );
    expect(transmuterBlock(config)).toEqual({
      compiler: 'cc -c {{inputPath}} -o {{outputPath}}',
      profile: 'agbcc',
      concurrency: 4,
      maxCompiles: 500,
      timeoutMs: 60000,
      noReduce: true,
      isolate: false,
      ruleWeights: { 'swap-operands': 2 },
      disabledRules: ['reorder-decls'],
      diffSettings: { functionRelocDiffs: 'none' },
      mutationDepth: 3,
    });
  });

  it('returns undefined when there is no decomp.yaml or no tools.transmuter', () => {
    expect(transmuterBlock(null)).toBeUndefined();
    expect(transmuterBlock(loaded('platform: gba\ntools:\n  asmlift: {}\n'))).toBeUndefined();
  });

  it('refuses a setting of the wrong type and a setting it does not know, naming each', () => {
    const config = loaded('tools:\n  transmuter:\n    concurrency: "4"\n    compilier: cc\n');
    expect(() => transmuterBlock(config)).toThrow(DecompYamlError);
    expect(() => transmuterBlock(config)).toThrow(
      [
        '/p/decomp.yaml: tools.transmuter.concurrency: Invalid input: expected number, received string',
        '/p/decomp.yaml: tools.transmuter: Unrecognized key: "compilier"',
      ].join('\n'),
    );
  });
});
