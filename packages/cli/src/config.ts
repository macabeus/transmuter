/**
 * `tools.transmuter`: the block Transmuter reads from a project's decomp.yaml. Finding and reading
 * the file is @match-kit/decomp-yaml's.
 */
import { type LoadedConfig, toolBlock } from '@match-kit/decomp-yaml';
import * as z from 'zod';

/** A key the block does not name is an error, so a misspelt setting is refused instead of ignored. */
const TRANSMUTER_TOOL = z.strictObject({
  compiler: z.string().optional(),
  profile: z.string().optional(),
  concurrency: z.number().optional(),
  maxCompiles: z.number().optional(),
  timeoutMs: z.number().optional(),
  noReduce: z.boolean().optional(),
  isolate: z.boolean().optional(),
  ruleWeights: z.record(z.string(), z.number()).optional(),
  disabledRules: z.array(z.string()).optional(),
  diffSettings: z.record(z.string(), z.string()).optional(),
  mutationDepth: z.number().optional(),
});

export type TransmuterToolConfig = z.output<typeof TRANSMUTER_TOOL>;

/**
 * `tools.transmuter` of `loaded`, checked; `undefined` when there is no config or no block. Throws
 * `DecompYamlError` naming each key of the wrong type and each key Transmuter does not know.
 */
export function transmuterBlock(loaded: LoadedConfig | null): TransmuterToolConfig | undefined {
  return toolBlock(loaded, 'transmuter', TRANSMUTER_TOOL);
}
