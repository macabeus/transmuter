/**
 * Scorer — scores a compiled candidate against the target with @matchkit/scoring, the scorer
 * asmlift uses too.
 *
 * Score = instruction-level difference count between candidate and target.
 * Lower is better, 0 = perfect match.
 */
import {
  type Inspection,
  type Scorer as MatchkitScorer,
  SymbolNotFoundError,
  type Target,
  createScorer,
  loadEngine,
} from '@matchkit/scoring';
import { assembly, differences, sideBySide } from '@matchkit/scoring/display';
import fs from 'fs/promises';
import type { AssemblyScoreResult, DiffType, StructuredDifference } from '~/types.js';

/** What `Scorer.report` returns: one candidate, every way a report shows it. */
export interface DiffReport {
  assembly: string;
  targetAssembly: string;
  /** target and candidate side by side */
  diff: string;
  /** the differing rows as prompt text, four lines each */
  differences: string[];
  structuredDifferences: StructuredDifference[];
  differenceCount: number;
  matchingCount: number;
}

const DIFF_TYPE_LABELS: Record<DiffType, string> = {
  insert: 'INSERTION',
  delete: 'DELETION',
  replace: 'REPLACEMENT',
  opMismatch: 'OPCODE_MISMATCH',
  argMismatch: 'ARGUMENT_MISMATCH',
};

export class Scorer {
  #targetObjectPath: string;
  #functionName: string;
  #diffSettings: Record<string, string>;

  #scorer: MatchkitScorer | null = null;
  #target: Target | null = null;

  constructor(targetObjectPath: string, functionName: string, diffSettings: Record<string, string> = {}) {
    this.#targetObjectPath = targetObjectPath;
    this.#functionName = functionName;
    this.#diffSettings = diffSettings;
  }

  /** Initialize: load the engine and parse the target object once. */
  async init(): Promise<void> {
    const scorer = createScorer(await loadEngine(), { diffSettings: this.#diffSettings });
    this.#target = scorer.parseTarget(new Uint8Array(await fs.readFile(this.#targetObjectPath)));
    this.#scorer = scorer;
  }

  /**
   * Score a compiled candidate object file.
   * Returns the difference count (lower = better, 0 = perfect match).
   * Returns null if the function symbol is not found. Throws when the pair cannot be diffed (an
   * object the engine cannot parse, a row it cannot display) — that is never a score.
   */
  async score(candidateObjPath: string): Promise<number | null> {
    const inspection = await this.#inspect(candidateObjPath);
    return inspection?.score.score ?? null;
  }

  /** Score a candidate and also extract its assembly and the side-by-side diff, in one pass. */
  async scoreWithAssembly(candidateObjPath: string): Promise<AssemblyScoreResult | null> {
    const inspection = await this.#inspect(candidateObjPath);
    if (inspection === null) {
      return null;
    }
    const { score, breakdown } = inspection.score;
    return {
      score,
      breakdown: { total: score, ...breakdown },
      assembly: assembly(inspection, 'candidate'),
      assemblyDiff: sideBySide(inspection),
    };
  }

  /**
   * Target and candidate side by side, a `|` between them where a row differs.
   * Returns null if the function is not found.
   */
  async assemblyDiff(candidateObjPath: string): Promise<string | null> {
    const inspection = await this.#inspect(candidateObjPath);
    return inspection === null ? null : sideBySide(inspection);
  }

  /**
   * Everything a report shows about one candidate: both sides' assembly, the side-by-side diff, and
   * each differing row. Returns null if the function is not found.
   */
  async report(candidateObjPath: string): Promise<DiffReport | null> {
    const inspection = await this.#inspect(candidateObjPath);
    if (inspection === null) {
      return null;
    }
    const structuredDifferences = differences(inspection).map(
      (d): StructuredDifference => ({
        row: d.row,
        type: d.kind,
        candidateInstruction: d.candidate,
        targetInstruction: d.target,
      }),
    );
    return {
      assembly: assembly(inspection, 'candidate'),
      targetAssembly: assembly(inspection, 'target'),
      diff: sideBySide(inspection),
      differences: structuredDifferences.flatMap((d, i) => [
        `Difference ${i + 1} (${DIFF_TYPE_LABELS[d.type]}):`,
        `- Current: \`${d.candidateInstruction || '(empty)'}\``,
        `- Target:  \`${d.targetInstruction || '(empty)'}\``,
        '',
      ]),
      structuredDifferences,
      differenceCount: inspection.score.score,
      matchingCount: inspection.score.matching,
    };
  }

  async #inspect(candidateObjPath: string): Promise<Inspection | null> {
    if (!this.#scorer || !this.#target) {
      throw new Error('Scorer not initialized — call init() first');
    }
    const candidate = new Uint8Array(await fs.readFile(candidateObjPath));
    try {
      return this.#scorer.inspect(this.#target, candidate, this.#functionName);
    } catch (error) {
      if (error instanceof SymbolNotFoundError) {
        return null;
      }
      throw error;
    }
  }
}
