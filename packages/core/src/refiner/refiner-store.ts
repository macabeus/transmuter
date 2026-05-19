/**
 * Captures Refiner events and produces a RefinementReport.
 */
import { createPatch } from 'diff';
import type {
  FocusResult,
  MergeLogEntry,
  PendingMerge,
  RefinementConfig,
  RefinementReport,
  RefinementResult,
  RefinerEvent,
  RuleStatsEntry,
  SessionMetadata,
  SessionReport,
  ViolationReport,
} from '~/types.js';

/**
 * Sum-aggregate `RuleStatsEntry` arrays by `ruleId`. Used to combine stats from
 * multiple sub-sessions (completed sub-session reports + live sub-session
 * `SessionStore.getRuleStats()` snapshots) into a single rule history view.
 *
 * `successRate` and `avgDelta` are derived fields, so they're recomputed from
 * the summed `applied`/`forked`/`totalDelta` rather than averaged. The result
 * is sorted by `forked` descending to match the per-session convention.
 */
export function mergeRuleStats(arrays: readonly (readonly RuleStatsEntry[])[]): RuleStatsEntry[] {
  const merged = new Map<
    string,
    {
      description: string;
      applied: number;
      forked: number;
      totalDelta: number;
      bestDelta: number;
      errors: number;
      focusApplied: number;
      focusForked: number;
      deltaByType: { insert: number; delete: number; replace: number; opMismatch: number; argMismatch: number };
    }
  >();

  for (const stats of arrays) {
    for (const rs of stats) {
      const existing = merged.get(rs.ruleId);
      if (existing) {
        existing.applied += rs.applied;
        existing.forked += rs.forked;
        existing.totalDelta += rs.avgDelta * rs.forked;
        existing.bestDelta = Math.max(existing.bestDelta, rs.bestDelta);
        existing.errors += rs.errors;
        existing.focusApplied += rs.focusApplied;
        existing.focusForked += rs.focusForked;
        existing.deltaByType.insert += rs.deltaByType.insert;
        existing.deltaByType.delete += rs.deltaByType.delete;
        existing.deltaByType.replace += rs.deltaByType.replace;
        existing.deltaByType.opMismatch += rs.deltaByType.opMismatch;
        existing.deltaByType.argMismatch += rs.deltaByType.argMismatch;
        // Prefer a non-empty description if we got one later.
        if (!existing.description && rs.description) {
          existing.description = rs.description;
        }
      } else {
        merged.set(rs.ruleId, {
          description: rs.description,
          applied: rs.applied,
          forked: rs.forked,
          totalDelta: rs.avgDelta * rs.forked,
          bestDelta: rs.bestDelta,
          errors: rs.errors,
          focusApplied: rs.focusApplied,
          focusForked: rs.focusForked,
          deltaByType: { ...rs.deltaByType },
        });
      }
    }
  }

  return [...merged.entries()]
    .map(([ruleId, s]) => ({
      ruleId,
      description: s.description,
      applied: s.applied,
      forked: s.forked,
      successRate: s.applied > 0 ? s.forked / s.applied : 0,
      avgDelta: s.forked > 0 ? s.totalDelta / s.forked : 0,
      bestDelta: s.bestDelta,
      errors: s.errors,
      focusApplied: s.focusApplied,
      focusForked: s.focusForked,
      deltaByType: { ...s.deltaByType },
    }))
    .sort((a, b) => b.forked - a.forked);
}

export class RefinementStore {
  #metadata: { -readonly [K in keyof SessionMetadata]: SessionMetadata[K] };
  #config: RefinementConfig | null = null;
  #guidelineId = '';
  #guidelineDescription = '';
  #violations: ViolationReport[] = [];
  #mergeLog: MergeLogEntry[] = [];
  #finalResult: RefinementResult | null = null;
  #originalSource = '';
  #subSessions = new Map<string, SessionReport>();

  constructor(options?: { sessionId?: string; label?: string }) {
    this.#metadata = {
      sessionId: options?.sessionId ?? `refine-${Date.now()}`,
      label: options?.label,
      createdAt: new Date().toISOString(),
    };
  }

  setConfig(config: RefinementConfig): void {
    this.#config = config;
    this.#guidelineId = config.guidelineId;
  }

  setGuidelineDescription(description: string): void {
    this.#guidelineDescription = description;
  }

  setOriginalSource(source: string): void {
    this.#originalSource = source;
  }

  setViolations(violations: ViolationReport[]): void {
    this.#violations = violations;
  }

  hasViolation(violationId: string): boolean {
    return this.#violations.some((v) => v.id === violationId);
  }

  push(event: RefinerEvent): void {
    switch (event.type) {
      case 'violation-fix-started': {
        const v = this.#violations.find((v) => v.id === event.violationId);
        if (v) {
          v.status = 'exploring';
          v.liveProgress = { iteration: 0, score: -1 };
        }
        break;
      }

      case 'violation-fix-progress': {
        const v = this.#violations.find((v) => v.id === event.violationId);
        if (v) {
          v.status = 'exploring';
          const prevScore = v.liveProgress?.score ?? -1;
          const bestScore = prevScore >= 0 ? Math.min(prevScore, event.score) : event.score;
          v.liveProgress = { iteration: event.iteration, score: bestScore };
        }
        break;
      }

      case 'violation-trivially-fixed': {
        const v = this.#violations.find((v) => v.id === event.violationId);
        if (v) {
          v.status = 'trivially-fixed';
          v.liveProgress = undefined;
          v.fixedSource = event.fixedSource;
          v.fixDiff = createPatch('source.c', this.#originalSource, event.fixedSource, 'original', 'fixed');
        }
        break;
      }

      case 'violation-fixed': {
        const v = this.#violations.find((v) => v.id === event.violationId);
        if (v) {
          v.status = 'fixed';
          v.liveProgress = undefined;
          if (v.exploration) {
            v.exploration.iterations = event.iterations;
            v.exploration.elapsed = event.elapsed;
            v.exploration.finalScore = 0;
          }
        }
        break;
      }

      case 'violation-removal-failed': {
        const v = this.#violations.find((v) => v.id === event.violationId);
        if (v) {
          v.status = 'removal-failed';
          v.liveProgress = undefined;
        }
        break;
      }

      case 'violation-transmuter-exhausted': {
        const v = this.#violations.find((v) => v.id === event.violationId);
        if (v) {
          v.status = 'transmuter-exhausted';
          v.liveProgress = undefined;
          if (v.exploration) {
            v.exploration.iterations = event.iterations;
            v.exploration.finalScore = event.bestScore;
          }
        }
        break;
      }

      case 'merge-step': {
        this.#mergeLog.push({
          step: event.step,
          violationId: event.violationId,
          action: event.action,
        });
        break;
      }

      case 'completed': {
        this.#finalResult = event.result;
        this.#metadata.completedAt = new Date().toISOString();
        break;
      }
    }
  }

  /** Update a merge log entry with source/diff info. */
  updateMergeStep(step: number, sourceAfter: string, previousSource: string): void {
    const entry = this.#mergeLog.find((e) => e.step === step);
    if (entry) {
      entry.sourceAfter = sourceAfter;
      entry.diff = createPatch('source.c', previousSource, sourceAfter, 'before', 'after');
    }
  }

  /** Store a sub-session report for a violation's internal MutationSearch run. */
  setSubSession(violationId: string, subSession: SessionReport): void {
    this.#subSessions.set(violationId, subSession);
  }

  /** Update a violation's fixed source and diff. */
  updateViolationFix(violationId: string, fixedSource: string): void {
    const v = this.#violations.find((v) => v.id === violationId);
    if (v) {
      v.fixedSource = fixedSource;
      v.fixDiff = createPatch('source.c', this.#originalSource, fixedSource, 'original', 'fixed');
    }
  }

  /**
   * Rule stats aggregated across every completed sub-session this store has
   * received via {@link setSubSession}. Live (still-running) sub-sessions are
   * not included — that's the Refiner's responsibility, since the store does
   * not see them. Use {@link Refiner.getRuleStats} for the merged view.
   */
  getRuleStats(): RuleStatsEntry[] {
    return mergeRuleStats([...this.#subSessions.values()].map((sub) => sub.ruleStats));
  }

  /** The completed merge log. */
  getMergeLog(): MergeLogEntry[] {
    return this.#mergeLog.map((e) => ({ ...e }));
  }

  /**
   * Violations whose Phase 1 fix is ready but has not yet been merged into the
   * spine. Drains to empty after Phase 2 finishes (every fix becomes a merge
   * log entry, regardless of whether it succeeded or was rejected).
   */
  getPendingMerges(): PendingMerge[] {
    const merged = new Set(this.#mergeLog.map((e) => e.violationId));
    const pending: PendingMerge[] = [];
    for (const v of this.#violations) {
      if (merged.has(v.id)) {
        continue;
      }
      if (v.status === 'fixed' || v.status === 'trivially-fixed') {
        pending.push({ violationId: v.id, status: v.status, fixedSource: v.fixedSource });
      }
    }
    return pending;
  }

  toJSON(): RefinementReport {
    // Attach sub-session reports to their corresponding violations
    const violations = this.#violations.map((v) => {
      const copy = { ...v };
      const sub = this.#subSessions.get(v.id);
      if (sub && copy.exploration) {
        copy.exploration = { ...copy.exploration, subSession: sub };
      }
      return copy;
    });

    // Aggregate focus results from all sub-sessions, keyed by violationId
    const focusResults: Record<string, readonly FocusResult[]> = {};
    for (const [violationId, sub] of this.#subSessions) {
      if (sub.focusResults.length > 0) {
        focusResults[violationId] = sub.focusResults;
      }
    }

    const ruleStats = this.getRuleStats();

    return {
      version: 1,
      type: 'refinement',
      metadata: { ...this.#metadata },
      config: this.#config ?? {
        functionName: '',
        targetObjectPath: '',
        compilerCommand: '',
        language: 'c' as const,
        guidelineId: this.#guidelineId,
        concurrency: 0,
        maxCompilesPerViolation: 0,
        timeoutMsPerViolation: 0,
        seed: 0,
      },
      guideline: { id: this.#guidelineId, description: this.#guidelineDescription },
      violations,
      mergeLog: this.#mergeLog.map((e) => ({ ...e })),
      finalResult: this.#finalResult ?? {
        source: this.#originalSource,
        violationsFixed: 0,
        violationsTotal: this.#violations.length,
        trivialFixes: 0,
        permutedFixes: 0,
        resolvedByPrior: 0,
        notFixable: 0,
        elapsed: 0,
      },
      focusResults: Object.keys(focusResults).length > 0 ? focusResults : undefined,
      ruleStats,
    };
  }

  async saveReport(outputPath: string): Promise<void> {
    const fs = await import('fs/promises');
    const data = JSON.stringify(this.toJSON(), null, 2);
    await fs.writeFile(outputPath, data);
  }

  async saveReportAtomic(outputPath: string): Promise<void> {
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const dir = pathMod.dirname(outputPath);
    const tmpPath = pathMod.join(dir, `.tmp-${pathMod.basename(outputPath)}-${process.pid}`);
    const data = JSON.stringify(this.toJSON(), null, 2);
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, outputPath);
  }
}
