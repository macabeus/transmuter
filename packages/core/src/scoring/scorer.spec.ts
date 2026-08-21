import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Scorer } from './scorer.js';
import { ARM_DIFF_SETTINGS, armThumbAsm, assembleArmThumb, ensureArmToolchain, thumbFunc } from './test-utils.js';

describe('Scorer', () => {
  let tempDir: string;
  let addOnePath: string;
  let addImm2Path: string;
  let subOnePath: string;
  let addOneTwicePath: string;
  let renamedPath: string;

  beforeAll(async () => {
    ensureArmToolchain();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transmuter-scorer-spec-'));

    // Baseline: 2-instruction Thumb function.
    addOnePath = await assembleArmThumb(tempDir, 'add_one', armThumbAsm(thumbFunc('add_one', ['add r0, #1', 'bx lr'])));
    // Same shape & length, different immediate → expected argMismatch.
    addImm2Path = await assembleArmThumb(
      tempDir,
      'add_imm2',
      armThumbAsm(thumbFunc('add_one', ['add r0, #2', 'bx lr'])),
    );
    // Same shape & operands, different mnemonic → expected opMismatch.
    subOnePath = await assembleArmThumb(tempDir, 'sub_one', armThumbAsm(thumbFunc('add_one', ['sub r0, #1', 'bx lr'])));
    // One extra instruction → expected insert/delete depending on direction.
    addOneTwicePath = await assembleArmThumb(
      tempDir,
      'add_one_twice',
      armThumbAsm(thumbFunc('add_one', ['add r0, #1', 'add r0, #1', 'bx lr'])),
    );
    // Same body, different symbol name — exercises the "symbol missing from
    // the candidate" null path on every public method.
    renamedPath = await assembleArmThumb(
      tempDir,
      'renamed',
      armThumbAsm(thumbFunc('something_else', ['add r0, #1', 'bx lr'])),
    );
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------------
  // init()
  // ---------------------------------------------------------------------------

  describe('init()', () => {
    it.each([
      ['score', (s: Scorer, p: string) => s.score(p)],
      ['scoreWithAssembly', (s: Scorer, p: string) => s.scoreWithAssembly(p)],
      ['assemblyDiff', (s: Scorer, p: string) => s.assemblyDiff(p)],
    ] as const)('throws from %s() when init() has not been called', async (_name, call) => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await expect(call(scorer, addOnePath)).rejects.toThrow(/not initialized/);
    });
  });

  // ---------------------------------------------------------------------------
  // score()
  // ---------------------------------------------------------------------------

  describe('score()', () => {
    it('returns 0 for a perfect match (identical object files)', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      expect(await scorer.score(addOnePath)).toBe(0);
    });

    it('returns a positive score when the candidate differs by an immediate', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const score = await scorer.score(addImm2Path);
      expect(score).not.toBeNull();
      expect(score!).toBeGreaterThan(0);
    });

    it('returns a positive score when the candidate has an extra instruction', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const score = await scorer.score(addOneTwicePath);
      expect(score).not.toBeNull();
      expect(score!).toBeGreaterThan(0);
    });

    it('returns null when the function is missing from the candidate', async () => {
      // Target has `add_one`, candidate only has `something_else` — the
      // realistic regression case (LLM renamed the function by mistake).
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      expect(await scorer.score(renamedPath)).toBeNull();
    });

    it('resolves by the symbol name it was given, not the source function name', async () => {
      // Scorer keys off the object-file symbol, which is what makes C++
      // support possible: a method written as `getSlotResult` in the source
      // may be emitted as `getSlotResult__11TTelesaSlotFv`, so callers pass
      // MutationSearchOptions.symbolName here while the mutation engine keeps
      // using functionName for its AST lookup.
      //
      // `renamed` holds the same body as `add_one` under the symbol
      // `something_else`, so scoring it against itself by that symbol is a
      // perfect match, even though no source-level `add_one` is involved.
      const scorer = new Scorer(renamedPath, 'something_else', ARM_DIFF_SETTINGS);
      await scorer.init();
      expect(await scorer.score(renamedPath)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // scoreWithAssembly()
  // ---------------------------------------------------------------------------

  describe('scoreWithAssembly()', () => {
    it('returns a zero breakdown and readable assembly on perfect match', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const result = await scorer.scoreWithAssembly(addOnePath);

      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
      expect(result!.breakdown).toEqual({
        total: 0,
        insert: 0,
        delete: 0,
        replace: 0,
        opMismatch: 0,
        argMismatch: 0,
      });
      // Non-empty assembly mentioning the register we used.
      expect(result!.assembly.length).toBeGreaterThan(0);
      expect(result!.assembly).toMatch(/r0/);
      // Side-by-side diff header.
      expect(result!.assemblyDiff).toContain('candidate');
      expect(result!.assemblyDiff).toContain('target');
    });

    it('classifies a single immediate change as argMismatch (same length, different arg)', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const result = await scorer.scoreWithAssembly(addImm2Path);

      expect(result).not.toBeNull();
      expect(result!.breakdown.total).toBeGreaterThan(0);
      expect(result!.breakdown.argMismatch).toBeGreaterThan(0);
      // No insert/delete — the functions have the same instruction count.
      expect(result!.breakdown.insert).toBe(0);
      expect(result!.breakdown.delete).toBe(0);
    });

    it('classifies a different-mnemonic change as replace', async () => {
      // `add r0, #1` vs `sub r0, #1` — same encoding shape, different opcode.
      // On ARMv4T, objdiff's alignment rules never emit `op-mismatch` for
      // these: anything with a different mnemonic lands in the `replace`
      // bucket (op-mismatch is effectively a MIPS-profile thing). This test
      // exists to pin down the `replace` classification for the common
      // "LLM chose the wrong instruction" case.
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const result = await scorer.scoreWithAssembly(subOnePath);

      expect(result).not.toBeNull();
      expect(result!.breakdown.total).toBeGreaterThan(0);
      expect(result!.breakdown.replace).toBeGreaterThan(0);
      expect(result!.breakdown.insert).toBe(0);
      expect(result!.breakdown.delete).toBe(0);
      expect(result!.breakdown.opMismatch).toBe(0);
      expect(result!.breakdown.argMismatch).toBe(0);
    });

    it('buckets an extra instruction in the CANDIDATE under insert/delete', async () => {
      // candidate = addOneTwice (3 insns), target = addOne (2 insns).
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const result = await scorer.scoreWithAssembly(addOneTwicePath);

      expect(result).not.toBeNull();
      expect(result!.breakdown.total).toBeGreaterThan(0);
      expect(result!.breakdown.insert + result!.breakdown.delete).toBeGreaterThan(0);
    });

    it('buckets an extra instruction in the TARGET under insert/delete', async () => {
      // Mirror of the previous test with target/candidate swapped, exercising
      // the opposite alignment direction.
      const scorer = new Scorer(addOneTwicePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const result = await scorer.scoreWithAssembly(addOnePath);

      expect(result).not.toBeNull();
      expect(result!.breakdown.total).toBeGreaterThan(0);
      expect(result!.breakdown.insert + result!.breakdown.delete).toBeGreaterThan(0);
    });

    it('returns null when the function symbol is missing from the candidate', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      expect(await scorer.scoreWithAssembly(renamedPath)).toBeNull();
    });

    it('its `.score` field matches what score() returns for the same candidate', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const fromScore = await scorer.score(addImm2Path);
      const fromScoreWithAssembly = await scorer.scoreWithAssembly(addImm2Path);
      expect(fromScore).not.toBeNull();
      expect(fromScoreWithAssembly).not.toBeNull();
      expect(fromScoreWithAssembly!.score).toBe(fromScore!);
    });
  });

  // ---------------------------------------------------------------------------
  // assemblyDiff()
  // ---------------------------------------------------------------------------

  describe('assemblyDiff()', () => {
    it('emits a header and no `| ` markers on a perfect match', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const diff = await scorer.assemblyDiff(addOnePath);

      expect(diff).not.toBeNull();
      expect(diff!).toContain('candidate');
      expect(diff!).toContain('target');
      // The diff-kind marker — only present when a row actually differs.
      expect(diff!.includes('| ')).toBe(false);
    });

    it('emits `| ` markers when the two sides differ', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      const diff = await scorer.assemblyDiff(addImm2Path);
      expect(diff).not.toBeNull();
      expect(diff!).toContain('| ');
    });

    it('returns null when the function is missing from the candidate', async () => {
      const scorer = new Scorer(addOnePath, 'add_one', ARM_DIFF_SETTINGS);
      await scorer.init();
      expect(await scorer.assemblyDiff(renamedPath)).toBeNull();
    });
  });
});
