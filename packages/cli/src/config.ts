/**
 * decomp.yaml config loader for the CLI.
 *
 * Reads the standard decomp_settings format and extracts
 * tools.transmuter configuration.
 */
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

export interface TransmuterToolConfig {
  compiler?: string;
  profile?: string;
  concurrency?: number;
  maxCompiles?: number;
  timeoutMs?: number;
  noReduce?: boolean;
  isolate?: boolean;
  ruleWeights?: Record<string, number>;
  disabledRules?: string[];
  diffSettings?: Record<string, string>;
  mutationDepth?: number;
}

export interface DecompYamlConfig {
  name?: string;
  platform?: string;
  versions?: Array<{
    name: string;
    paths?: {
      target?: string;
      build_dir?: string;
      map?: string;
      asm?: string;
      nonmatchings?: string;
    };
  }>;
  tools?: {
    transmuter?: TransmuterToolConfig;
    [key: string]: unknown;
  };
}

/**
 * Walk up from startDir to find decomp.yaml.
 * Returns the parsed config or null if not found.
 */
export async function loadDecompYaml(explicitPath?: string, startDir?: string): Promise<DecompYamlConfig | null> {
  if (explicitPath) {
    return readDecompYaml(explicitPath);
  }

  let dir = startDir ? path.resolve(startDir) : process.cwd();

  while (true) {
    const candidate = path.join(dir, 'decomp.yaml');
    try {
      await fs.access(candidate);
      return readDecompYaml(candidate);
    } catch {
      // Not found, try parent
    }

    // Also try decomp.yml
    const candidate2 = path.join(dir, 'decomp.yml');
    try {
      await fs.access(candidate2);
      return readDecompYaml(candidate2);
    } catch {
      // Not found, try parent
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    } // Reached filesystem root
    dir = parent;
  }

  return null;
}

async function readDecompYaml(filePath: string): Promise<DecompYamlConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  return YAML.parse(content) as DecompYamlConfig;
}
