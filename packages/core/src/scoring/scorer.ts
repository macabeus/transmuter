/**
 * Scorer — wraps objdiff-wasm for assembly comparison and scoring.
 *
 * Score = instruction-level difference count between candidate and target.
 * Lower is better, 0 = perfect match.
 */
import type * as ObjdiffWasm from 'objdiff-wasm';
import type { AssemblyScoreResult, DiffBreakdown } from '~/types.js';

type ObjdiffModule = typeof ObjdiffWasm;
type ParsedObject = ObjdiffWasm.diff.Object;
type ObjectDiff = ObjdiffWasm.diff.ObjectDiff;
type DiffConfig = ObjdiffWasm.diff.DiffConfig;

/** Lazy singleton for the WASM module. */
let wasmModulePromise: Promise<ObjdiffModule> | null = null;

async function getObjdiffModule(): Promise<ObjdiffModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = initObjdiff();
  }
  return wasmModulePromise;
}

async function initObjdiff(): Promise<ObjdiffModule> {
  const objdiff = await import('objdiff-wasm');
  objdiff.init('error');
  return objdiff;
}

export class Scorer {
  #targetObjectPath: string;
  #functionName: string;
  #diffSettings: Record<string, string>;

  #objdiff: ObjdiffModule | null = null;
  #targetObj: ParsedObject | null = null;
  #diffConfig: DiffConfig | null = null;

  constructor(targetObjectPath: string, functionName: string, diffSettings: Record<string, string> = {}) {
    this.#targetObjectPath = targetObjectPath;
    this.#functionName = functionName;
    this.#diffSettings = diffSettings;
  }

  /** Initialize: load WASM, parse the target object, create diff config. */
  async init(): Promise<void> {
    this.#objdiff = await getObjdiffModule();
    this.#diffConfig = new this.#objdiff.diff.DiffConfig();
    for (const [key, value] of Object.entries(this.#diffSettings)) {
      this.#diffConfig.setProperty(key, value);
    }

    const targetBuffer = await Bun.file(this.#targetObjectPath).arrayBuffer();
    this.#targetObj = this.#objdiff.diff.Object.parse(new Uint8Array(targetBuffer), this.#diffConfig, 'target');
  }

  /**
   * Score a compiled candidate object file.
   * Returns the difference count (lower = better, 0 = perfect match).
   * Returns null if the function symbol is not found.
   */
  async score(candidateObjPath: string): Promise<number | null> {
    if (!this.#objdiff || !this.#targetObj || !this.#diffConfig) {
      throw new Error('Scorer not initialized — call init() first');
    }

    const candidateBuffer = await Bun.file(candidateObjPath).arrayBuffer();
    const candidateObj = this.#objdiff.diff.Object.parse(new Uint8Array(candidateBuffer), this.#diffConfig, 'base');

    const mappingConfig = {
      mappings: [],
      selectingLeft: undefined,
      selectingRight: undefined,
    };

    const diffResult = this.#objdiff.diff.runDiff(candidateObj, this.#targetObj, this.#diffConfig, mappingConfig);

    if (!diffResult.left || !diffResult.right) {
      return null;
    }

    const breakdown = this.#extractDiffBreakdown(diffResult.left, diffResult.right);
    return breakdown?.total ?? null;
  }

  /**
   * Score a candidate and also extract assembly + diff in one pass.
   * Avoids re-parsing the object file compared to calling score() + assemblyDiff() separately.
   */
  async scoreWithAssembly(candidateObjPath: string): Promise<AssemblyScoreResult | null> {
    if (!this.#objdiff || !this.#targetObj || !this.#diffConfig) {
      throw new Error('Scorer not initialized — call init() first');
    }

    const candidateBuffer = await Bun.file(candidateObjPath).arrayBuffer();
    const candidateObj = this.#objdiff.diff.Object.parse(new Uint8Array(candidateBuffer), this.#diffConfig, 'base');

    const mappingConfig = {
      mappings: [],
      selectingLeft: undefined,
      selectingRight: undefined,
    };

    const diffResult = this.#objdiff.diff.runDiff(candidateObj, this.#targetObj, this.#diffConfig, mappingConfig);

    if (!diffResult.left || !diffResult.right) {
      return null;
    }

    const breakdown = this.#extractDiffBreakdown(diffResult.left, diffResult.right);
    if (breakdown === null) {
      return null;
    }

    const assembly = this.#extractAssembly(diffResult.left);
    const assemblyDiff = this.#formatAssemblyDiff(diffResult.left, diffResult.right) ?? '';

    return { score: breakdown.total, breakdown, assembly, assemblyDiff };
  }

  #extractAssembly(objDiff: ObjectDiff): string {
    const objdiff = this.#objdiff!;
    const diffConfig = this.#diffConfig!;

    const symbol = objDiff.findSymbol(this.#functionName, undefined);
    if (!symbol) {
      return '';
    }

    const display = objdiff.display.displaySymbol(objDiff, symbol.id);
    const lines: string[] = [];

    for (let row = 0; row < display.rowCount; row++) {
      try {
        const instrRow = objdiff.display.displayInstructionRow(objDiff, symbol.id, row, diffConfig);
        if (instrRow) {
          const text = this.#rowToText(instrRow.segments);
          if (text) {
            lines.push(text);
          }
        }
      } catch {
        // Skip rows that fail
      }
    }

    return lines.join('\n');
  }

  /**
   * Produce a side-by-side assembly diff between candidate and target.
   * Each line shows: candidate instruction | diff marker | target instruction.
   * Returns null if the function is not found.
   */
  async assemblyDiff(candidateObjPath: string): Promise<string | null> {
    if (!this.#objdiff || !this.#targetObj || !this.#diffConfig) {
      throw new Error('Scorer not initialized — call init() first');
    }

    const candidateBuffer = await Bun.file(candidateObjPath).arrayBuffer();
    const candidateObj = this.#objdiff.diff.Object.parse(new Uint8Array(candidateBuffer), this.#diffConfig, 'base');

    const mappingConfig = {
      mappings: [],
      selectingLeft: undefined,
      selectingRight: undefined,
    };

    const diffResult = this.#objdiff.diff.runDiff(candidateObj, this.#targetObj, this.#diffConfig, mappingConfig);

    if (!diffResult.left || !diffResult.right) {
      return null;
    }

    return this.#formatAssemblyDiff(diffResult.left, diffResult.right);
  }

  #formatAssemblyDiff(leftDiff: ObjectDiff, rightDiff: ObjectDiff): string | null {
    const objdiff = this.#objdiff!;
    const diffConfig = this.#diffConfig!;

    const leftSymbol = leftDiff.findSymbol(this.#functionName, undefined);
    const rightSymbol = rightDiff.findSymbol(this.#functionName, undefined);

    if (!leftSymbol || !rightSymbol) {
      return null;
    }

    const leftDisplay = objdiff.display.displaySymbol(leftDiff, leftSymbol.id);
    const rightDisplay = objdiff.display.displaySymbol(rightDiff, rightSymbol.id);
    const rowCount = Math.max(leftDisplay.rowCount, rightDisplay.rowCount);

    const lines: string[] = [];
    for (let row = 0; row < rowCount; row++) {
      try {
        const leftRow = objdiff.display.displayInstructionRow(leftDiff, leftSymbol.id, row, diffConfig);
        const rightRow = objdiff.display.displayInstructionRow(rightDiff, rightSymbol.id, row, diffConfig);

        const leftText = leftRow ? this.#rowToText(leftRow.segments) : '';
        const rightText = rightRow ? this.#rowToText(rightRow.segments) : '';

        const leftKind = leftRow?.diffKind ?? 'none';
        const rightKind = rightRow?.diffKind ?? 'none';
        const marker = leftKind === 'none' && rightKind === 'none' ? '  ' : '| ';

        lines.push(`${leftText.padEnd(40)} ${marker} ${rightText}`);
      } catch {
        lines.push(`${'???'.padEnd(40)} |  ???`);
      }
    }

    return `${'candidate'.padEnd(40)}    ${'target'}\n${'─'.repeat(40)} ── ${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  #rowToText(segments: { text: unknown }[]): string {
    let result = '';
    for (const seg of segments) {
      const t = seg.text as { tag: string; val: unknown };
      switch (t.tag) {
        case 'basic': // register names, punctuation (e.g., "r0", ", ", "#")
        case 'opaque': // misc text
          result += t.val as string;
          break;
        case 'line': // instruction size/line number — skip
        case 'branch-arrow': // visual branch arrow — skip for text output
          break;
        case 'spacing':
          result += ' '.repeat(t.val as number);
          break;
        case 'eol':
          break;
        case 'opcode': {
          const op = t.val as { mnemonic: string };
          result += op.mnemonic + ' ';
          break;
        }
        case 'address': {
          const addr = Number(t.val as bigint);
          result += `${addr.toString(16).padStart(2, '0')}: `;
          break;
        }
        case 'branch-dest':
          result += `0x${(t.val as bigint).toString(16)}`;
          break;
        case 'signed':
          result += String(t.val);
          break;
        case 'unsigned':
          result += String(t.val);
          break;
        case 'symbol': {
          const sym = t.val as { name: string };
          result += sym.name;
          break;
        }
        case 'addend':
          result += String(t.val);
          break;
        default:
          result += JSON.stringify(t.val);
          break;
      }
    }
    return result.trim();
  }

  #extractDiffBreakdown(leftDiff: ObjectDiff, rightDiff: ObjectDiff): DiffBreakdown | null {
    const objdiff = this.#objdiff!;
    const diffConfig = this.#diffConfig!;

    const leftSymbol = leftDiff.findSymbol(this.#functionName, undefined);
    const rightSymbol = rightDiff.findSymbol(this.#functionName, undefined);

    if (!leftSymbol || !rightSymbol) {
      return null;
    }

    const leftDisplay = objdiff.display.displaySymbol(leftDiff, leftSymbol.id);
    const rightDisplay = objdiff.display.displaySymbol(rightDiff, rightSymbol.id);
    const rowCount = Math.max(leftDisplay.rowCount, rightDisplay.rowCount);

    let insert = 0;
    let del = 0;
    let replace = 0;
    let opMismatch = 0;
    let argMismatch = 0;

    for (let row = 0; row < rowCount; row++) {
      try {
        const leftRow = objdiff.display.displayInstructionRow(leftDiff, leftSymbol.id, row, diffConfig);
        const rightRow = objdiff.display.displayInstructionRow(rightDiff, rightSymbol.id, row, diffConfig);

        const leftKind = leftRow?.diffKind ?? 'none';
        const rightKind = rightRow?.diffKind ?? 'none';

        if (leftKind === 'none' && rightKind === 'none') {
          continue;
        }

        if (leftKind === 'insert' || rightKind === 'insert') {
          insert++;
        } else if (leftKind === 'delete' || rightKind === 'delete') {
          del++;
        } else if (leftKind === 'op-mismatch' || rightKind === 'op-mismatch') {
          opMismatch++;
        } else if (leftKind === 'arg-mismatch' || rightKind === 'arg-mismatch') {
          argMismatch++;
        } else {
          replace++;
        }
      } catch {
        replace++;
      }
    }

    const total = insert + del + replace + opMismatch + argMismatch;
    return { total, insert, delete: del, replace, opMismatch, argMismatch };
  }
}
