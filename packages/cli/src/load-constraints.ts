/**
 * Load `--constraints <path>` JSON for both `match` and `refine`.
 *
 * Schema:
 *   {
 *     "focusConstraints": FocusConstraint[],
 *     "violationHypotheses": Record<violationId, { source, description? }>
 *                          | ViolationHypothesis[]
 *   }
 *
 * `violationHypotheses` is refine-only. The object form keyed by violationId is
 * the documented shape (`.claude/docs/refine-mode.md`); the array form matches
 * the canonical `ViolationHypothesis` type.
 */
import type { FocusConstraint, ViolationHypothesis } from '@transmuter/core';
import fs from 'fs/promises';

export interface LoadedConstraints {
  focusConstraints?: FocusConstraint[];
  violationHypotheses?: ViolationHypothesis[];
}

export async function loadConstraints(filePath: string): Promise<LoadedConstraints> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    focusConstraints?: FocusConstraint[];
    violationHypotheses?: Record<string, { source: string; description?: string }> | ViolationHypothesis[];
  };

  let violationHypotheses: ViolationHypothesis[] | undefined;
  if (Array.isArray(parsed.violationHypotheses)) {
    violationHypotheses = parsed.violationHypotheses;
  } else if (parsed.violationHypotheses) {
    violationHypotheses = Object.entries(parsed.violationHypotheses).map(([violationId, h]) => ({
      violationId,
      source: h.source,
      description: h.description,
    }));
  }

  return { focusConstraints: parsed.focusConstraints, violationHypotheses };
}
