/**
 * Source reducer — minimizes a C source file while preserving assembly output.
 *
 * Uses hierarchical delta debugging:
 * 1. Remove non-target functions
 * 2. Remove #include directives
 * 3. Remove global declarations
 * 4. Remove #define macros
 * 5. Stub remaining non-target functions
 */
import type { SgNode } from '@ast-grep/napi';
import { Compiler } from '~/compiler/compiler.js';
import { parse } from '~/parser.js';
import { getCFunctionName } from '~/rules/helpers.js';
import { Scorer } from '~/scoring/scorer.js';
import type { ReducerOptions, ReducerResult } from '~/types.js';

export class Reducer {
  #opts: ReducerOptions;
  #compiler: Compiler;
  #scorer: Scorer;
  #baselineScore: number | null = null;

  constructor(opts: ReducerOptions) {
    this.#opts = opts;
    this.#compiler = new Compiler({
      command: opts.compilerCommand,
      cwd: opts.cwd,
      functionName: opts.functionName,
      sourcePrefix: opts.sourcePrefix,
    });
    this.#scorer = new Scorer(opts.targetObjectPath, opts.functionName, opts.diffSettings);
  }

  /** Run the full reduction pipeline. */
  async reduce(): Promise<ReducerResult> {
    await this.#scorer.init();

    // Establish baseline score
    this.#baselineScore = await this.#compileAndScore(this.#opts.source);
    if (this.#baselineScore === null) {
      throw new Error('Base source does not compile or function not found in output');
    }

    let source = this.#opts.source;
    const removals: { phase: string; count: number }[] = [];

    // Phase 1: Remove non-target functions
    const [source1, count1] = await this.#removeFunctions(source);
    source = source1;
    removals.push({ phase: 'Functions', count: count1 });

    // Phase 2: Remove #include directives
    const [source2, count2] = await this.#removeDirectives(source, /^\s*#\s*include\s+.*/gm, 'Includes');
    source = source2;
    removals.push({ phase: 'Includes', count: count2 });

    // Phase 3: Remove global declarations
    const [source3, count3] = await this.#removeGlobalDeclarations(source);
    source = source3;
    removals.push({ phase: 'Globals', count: count3 });

    // Phase 4: Remove #define macros
    const [source4, count4] = await this.#removeDirectives(source, /^\s*#\s*define\s+.*/gm, 'Macros');
    source = source4;
    removals.push({ phase: 'Macros', count: count4 });

    // Phase 5: Stub remaining non-target functions
    const [source5, count5] = await this.#stubFunctions(source);
    source = source5;
    removals.push({ phase: 'Stubs', count: count5 });

    return {
      source,
      originalSize: Buffer.byteLength(this.#opts.source),
      reducedSize: Buffer.byteLength(source),
      removals,
    };
  }

  /** Compile source and return its score, or null on failure. */
  async #compileAndScore(source: string): Promise<number | null> {
    const result = await this.#compiler.compile(source);
    if (!result.success) {
      return null;
    }
    const score = await this.#scorer.score(result.objPath);
    await Compiler.cleanup(result.objPath);
    return score;
  }

  /** Check if removing code preserves the assembly score. */
  async #isRemovalSafe(source: string): Promise<boolean> {
    const score = await this.#compileAndScore(source);
    return score !== null && score === this.#baselineScore;
  }

  /**
   * Phase 1: Remove non-target function definitions.
   * Try removing all at once, then binary search if that changes the score.
   */
  async #removeFunctions(source: string): Promise<[string, number]> {
    const root = parse('c', source);
    const fnDefs = root.root().findAll({ rule: { kind: 'function_definition' } });

    const nonTarget = fnDefs.filter((fn) => getCFunctionName(fn) !== this.#opts.functionName);

    if (nonTarget.length === 0) {
      return [source, 0];
    }

    this.#emitProgress('Functions', 0, nonTarget.length);

    // Try removing all at once
    const allRemoved = this.#removeNodes(source, nonTarget);
    if (await this.#isRemovalSafe(allRemoved)) {
      this.#emitProgress('Functions', nonTarget.length, nonTarget.length);
      return [allRemoved, nonTarget.length];
    }

    // Binary search: find which functions are needed
    return this.#binarySearchRemove(source, nonTarget, 'Functions');
  }

  /**
   * Phase 2/4: Remove preprocessor directives matching a regex pattern.
   */
  async #removeDirectives(source: string, pattern: RegExp, phaseName: string): Promise<[string, number]> {
    const matches = [...source.matchAll(pattern)];
    if (matches.length === 0) {
      return [source, 0];
    }

    this.#emitProgress(phaseName, 0, matches.length);

    // Try removing all at once
    const allRemoved = source.replace(pattern, '');
    if (await this.#isRemovalSafe(allRemoved)) {
      this.#emitProgress(phaseName, matches.length, matches.length);
      return [allRemoved, matches.length];
    }

    // Try removing one at a time
    let current = source;
    let removed = 0;
    for (const match of matches) {
      const candidate = current.replace(match[0]!, '');
      if (await this.#isRemovalSafe(candidate)) {
        current = candidate;
        removed++;
      }
      this.#emitProgress(phaseName, removed, matches.length);
    }

    return [current, removed];
  }

  /**
   * Phase 3: Remove global variable declarations, typedefs, struct/union/enum definitions.
   */
  async #removeGlobalDeclarations(source: string): Promise<[string, number]> {
    const root = parse('c', source);
    const topLevel = root.root().children();

    // Collect global declarations (not function definitions, not preprocessor directives)
    const globals = topLevel.filter((node) => {
      const kind = node.kind();
      return (
        kind === 'declaration' ||
        kind === 'type_definition' ||
        kind === 'struct_specifier' ||
        kind === 'union_specifier' ||
        kind === 'enum_specifier'
      );
    });

    if (globals.length === 0) {
      return [source, 0];
    }

    this.#emitProgress('Globals', 0, globals.length);

    // Try removing all at once
    const allRemoved = this.#removeNodes(source, globals);
    if (await this.#isRemovalSafe(allRemoved)) {
      this.#emitProgress('Globals', globals.length, globals.length);
      return [allRemoved, globals.length];
    }

    // Binary search
    return this.#binarySearchRemove(source, globals, 'Globals');
  }

  /**
   * Phase 5: Replace non-target function bodies with stubs.
   */
  async #stubFunctions(source: string): Promise<[string, number]> {
    const root = parse('c', source);
    const fnDefs = root.root().findAll({ rule: { kind: 'function_definition' } });

    const nonTarget = fnDefs.filter((fn) => getCFunctionName(fn) !== this.#opts.functionName);

    if (nonTarget.length === 0) {
      return [source, 0];
    }

    this.#emitProgress('Stubs', 0, nonTarget.length);

    let current = source;
    let stubbed = 0;

    for (const fn of nonTarget) {
      const body = fn.find({ rule: { kind: 'compound_statement' } });
      if (!body) {
        continue;
      }

      // Determine return type to generate appropriate stub
      const returnType = this.#getReturnType(fn);
      const stubBody = returnType === 'void' ? '{}' : '{ return 0; }';

      // Re-parse to get fresh positions (source may have shifted from prior stubs)
      const origName = getCFunctionName(fn);
      const freshRoot = parse('c', current);
      const freshFn = freshRoot
        .root()
        .findAll({ rule: { kind: 'function_definition' } })
        .find((f) => getCFunctionName(f) === origName);

      if (!freshFn) {
        continue;
      }
      const freshBody = freshFn.find({ rule: { kind: 'compound_statement' } });
      if (!freshBody) {
        continue;
      }

      const candidate =
        current.slice(0, freshBody.range().start.index) + stubBody + current.slice(freshBody.range().end.index);

      if (await this.#isRemovalSafe(candidate)) {
        current = candidate;
        stubbed++;
      }
      this.#emitProgress('Stubs', stubbed, nonTarget.length);
    }

    return [current, stubbed];
  }

  /** Remove AST nodes from source (from end to start to preserve offsets). */
  #removeNodes(source: string, nodes: SgNode[]): string {
    // Sort by start position descending so we can remove from end to start
    const sorted = [...nodes].sort((a, b) => b.range().start.index - a.range().start.index);

    let result = source;
    for (const node of sorted) {
      const { start, end } = node.range();
      result = result.slice(0, start.index) + result.slice(end.index);
    }
    return result;
  }

  /**
   * Binary search for which nodes are needed.
   * Tries removing half at a time, then recurses.
   */
  async #binarySearchRemove(source: string, nodes: SgNode[], phaseName: string): Promise<[string, number]> {
    let current = source;
    let totalRemoved = 0;

    // Try each node individually (simple approach that works well in practice)
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      // Re-parse to get fresh node positions
      const freshRoot = parse('c', current);
      const freshNodes = freshRoot.root().findAll({ rule: { kind: node.kind() } });

      // Find the matching node by text content
      const freshNode = freshNodes.find((n) => n.text() === node.text());
      if (!freshNode) {
        continue;
      }

      const candidate = this.#removeNodes(current, [freshNode]);
      if (await this.#isRemovalSafe(candidate)) {
        current = candidate;
        totalRemoved++;
      }
      this.#emitProgress(phaseName, totalRemoved, nodes.length);
    }

    return [current, totalRemoved];
  }

  #getReturnType(fnNode: SgNode): string {
    // The first child before the declarator is typically the type specifier
    const children = fnNode.children();
    for (const child of children) {
      if (child.kind() === 'function_declarator') {
        break;
      }
      const text = child.text().trim();
      if (text === 'void') {
        return 'void';
      }
    }
    return 'int';
  }

  #emitProgress(phase: string, removed: number, total: number): void {
    this.#opts.onProgress?.(phase, removed, total);
  }
}
