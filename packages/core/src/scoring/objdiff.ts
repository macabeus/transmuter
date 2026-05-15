/**
 * Objdiff Wrapper
 *
 * Shared class wrapping objdiff-wasm.
 * Provides functionality to parse object files and extract assembly.
 */
import type * as ObjdiffWasm from 'objdiff-wasm';
import type { DiffType, StructuredDifference } from '~/types.js';

type ObjdiffModule = typeof ObjdiffWasm;
type ParsedObject = ObjdiffWasm.diff.Object;
type ObjectDiff = ObjdiffWasm.diff.ObjectDiff;
type DiffConfig = ObjdiffWasm.diff.DiffConfig;
type DiffSide = ObjdiffWasm.diff.DiffSide;

/**
 * Wrapper class for objdiff-wasm
 */
export class Objdiff {
  static #wasmModule: Promise<ObjdiffModule> | null = null;

  #diffSettings: Record<string, string>;

  constructor(diffSettings: Record<string, string> = {}) {
    this.#diffSettings = diffSettings;

    // Ensure WASM module is initialized (shared across all instances)
    if (!Objdiff.#wasmModule) {
      Objdiff.#wasmModule = Objdiff.#initializeObjdiff();
    }
  }

  static async #initializeObjdiff(): Promise<ObjdiffModule> {
    const objdiff = await import('objdiff-wasm');
    objdiff.init('error');
    return objdiff;
  }

  /**
   * Get the diff configuration using the instance's diff settings
   */
  async #getDiffConfig(): Promise<DiffConfig> {
    const objdiff = await Objdiff.#wasmModule!;
    const diffConfig = new objdiff.diff.DiffConfig();

    for (const [key, value] of Object.entries(this.#diffSettings)) {
      diffConfig.setProperty(key, value);
    }

    return diffConfig;
  }

  /**
   * Parse an object file
   */
  async parseObjectFile(filePath: string, side: DiffSide = 'base'): Promise<ParsedObject> {
    const objdiff = await Objdiff.#wasmModule!;
    const diffConfig = await this.#getDiffConfig();

    const fileBuffer = await Bun.file(filePath).arrayBuffer();
    const parsedObject = objdiff.diff.Object.parse(new Uint8Array(fileBuffer), diffConfig, side);

    return parsedObject;
  }

  /**
   * Run diff between two object files
   */
  async runDiff(left: ParsedObject, right?: ParsedObject): Promise<{ left?: ObjectDiff; right?: ObjectDiff }> {
    const objdiff = await Objdiff.#wasmModule!;
    const diffConfig = await this.#getDiffConfig();

    const mappingConfig = {
      mappings: [],
      selectingLeft: undefined,
      selectingRight: undefined,
    };

    return objdiff.diff.runDiff(left, right, diffConfig, mappingConfig);
  }

  /**
   * Get all symbol names from a parsed object
   */
  async getSymbolNames(obj: ParsedObject): Promise<string[]> {
    const objdiff = await Objdiff.#wasmModule!;
    const diffResult = await this.runDiff(obj);

    if (!diffResult.left) {
      return [];
    }

    const sections = objdiff.display.displaySections(
      diffResult.left,
      {},
      {
        showHiddenSymbols: false,
        showMappedSymbols: false,
        reverseFnOrder: false,
      },
    );

    const symbolNames: string[] = [];
    for (const section of sections) {
      for (const symbolRef of section.symbols) {
        const symbol = objdiff.display.displaySymbol(diffResult.left, symbolRef);
        symbolNames.push(symbol.info.name);
      }
    }

    return symbolNames;
  }

  /**
   * Get assembly for a specific symbol from an object diff
   */
  async getAssemblyFromSymbol(objDiff: ObjectDiff, symbolName: string): Promise<string> {
    const diffConfig = await this.#getDiffConfig();
    const instructions: string[] = [];

    for await (const [instructionRow] of this.#iterateSymbolRows([objDiff], symbolName, diffConfig)) {
      if (!instructionRow) {
        continue;
      }
      const lineText = this.#instructionDiffRowToString(instructionRow);
      if (lineText.trim()) {
        instructions.push(lineText);
      }
    }

    return instructions.join('\n');
  }

  /**
   * Get detailed differences between two object diffs for a function
   */
  async getDifferences(
    leftDiff: ObjectDiff,
    rightDiff: ObjectDiff,
    functionName: string,
  ): Promise<{
    differenceCount: number;
    matchingCount: number;
    differences: string[];
    structuredDifferences: StructuredDifference[];
  }> {
    const diffConfig = await this.#getDiffConfig();
    let differenceCount = 0;
    let matchingCount = 0;
    const differences: string[] = [];
    const structuredDifferences: StructuredDifference[] = [];
    let row = 0;

    for await (const [leftInstructionRow, rightInstructionRow] of this.#iterateSymbolRows(
      [leftDiff, rightDiff],
      functionName,
      diffConfig,
    )) {
      let leftInstruction = '';
      let rightInstruction = '';
      let leftDiffKind = 'none';
      let rightDiffKind = 'none';

      if (leftInstructionRow) {
        leftDiffKind = leftInstructionRow.diffKind;
        leftInstruction = this.#instructionDiffRowToString(leftInstructionRow);
      }

      if (rightInstructionRow) {
        rightDiffKind = rightInstructionRow.diffKind;
        rightInstruction = this.#instructionDiffRowToString(rightInstructionRow);
      }

      const leftClean = leftInstruction.replace(/\s+/g, ' ').trim();
      const rightClean = rightInstruction.replace(/\s+/g, ' ').trim();

      // One side has content but the other doesn't — always a difference.
      const oneSidedContent = (leftClean === '') !== (rightClean === '');

      const hasRealDifference = (leftDiffKind !== 'none' || rightDiffKind !== 'none') && leftDiffKind !== rightDiffKind;
      const contentDiffers = leftClean !== rightClean && leftClean !== '' && rightClean !== '';

      if (
        oneSidedContent ||
        hasRealDifference ||
        (contentDiffers && (leftDiffKind !== 'none' || rightDiffKind !== 'none'))
      ) {
        differenceCount++;

        let diffType = '';
        let structuredType: DiffType;
        if (oneSidedContent) {
          diffType = leftClean === '' ? 'INSERTION' : 'DELETION';
          structuredType = leftClean === '' ? 'insert' : 'delete';
        } else if (leftDiffKind === 'insert' || rightDiffKind === 'insert') {
          diffType = 'INSERTION';
          structuredType = 'insert';
        } else if (leftDiffKind === 'delete' || rightDiffKind === 'delete') {
          diffType = 'DELETION';
          structuredType = 'delete';
        } else if (leftDiffKind === 'replace' || rightDiffKind === 'replace') {
          diffType = 'REPLACEMENT';
          structuredType = 'replace';
        } else if (leftDiffKind === 'op-mismatch' || rightDiffKind === 'op-mismatch') {
          diffType = 'OPCODE_MISMATCH';
          structuredType = 'opMismatch';
        } else if (leftDiffKind === 'arg-mismatch' || rightDiffKind === 'arg-mismatch') {
          diffType = 'ARGUMENT_MISMATCH';
          structuredType = 'argMismatch';
        } else {
          diffType = 'INSTRUCTION_DIFFERENCE';
          structuredType = 'replace';
        }

        differences.push(`Difference ${differenceCount} (${diffType}):`);
        differences.push(`- Current: \`${leftInstruction.trim() || '(empty)'}\` [${leftDiffKind}]`);
        differences.push(`- Target:  \`${rightInstruction.trim() || '(empty)'}\` [${rightDiffKind}]`);
        differences.push('');

        structuredDifferences.push({
          row,
          type: structuredType,
          candidateInstruction: leftInstruction.trim(),
          targetInstruction: rightInstruction.trim(),
        });
      } else if (leftClean !== '' || rightClean !== '') {
        matchingCount++;
      }

      row++;
    }

    return { differenceCount, matchingCount, differences, structuredDifferences };
  }

  async *#iterateSymbolRows(objDiffs: ObjectDiff[], symbolName: string, diffConfig: DiffConfig) {
    const objdiff = await Objdiff.#wasmModule!;

    const symbols = objDiffs.map((objDiff) => objDiff.findSymbol(symbolName, undefined)!);
    const displaySymbols = objDiffs.map((objDiff, index) => objdiff.display.displaySymbol(objDiff, symbols[index]!.id));
    const instructionsCount = Math.max(...displaySymbols.map((displaySymbol) => displaySymbol.rowCount));

    for (let row = 0; row < instructionsCount; row++) {
      try {
        const instructionsRow = objDiffs.map((objDiff, index) =>
          objdiff.display.displayInstructionRow(objDiff, symbols[index]!.id, row, diffConfig),
        );
        yield instructionsRow;
      } catch {
        // Row access can fail for data sections — skip
      }
    }
  }

  /**
   * Convert an instruction diff row to a string representation
   */
  #instructionDiffRowToString(instructionRow: ObjdiffWasm.display.InstructionDiffRow): string {
    let lineText = '';
    let address = '';

    for (const segment of instructionRow.segments) {
      const text = segment.text;

      switch (text.tag) {
        case 'basic':
          if (text.val === ' ~>') {
            // do nothing
          } else if (text.val === ' (->') {
            lineText += ` # REFERENCE_`;
          } else if (text.val === ' ~> ') {
            lineText += `.L${address}:\n`;
          } else if (text.val === ')' && lineText.includes(' # REFERENCE_')) {
            // do nothing
          } else {
            lineText += text.val;
          }
          break;

        case 'line':
          // C source line numbers from DWARF debug info — skip them
          break;

        case 'address':
          // Track address for label generation but don't emit as prefix
          address = text.val.toString(16);
          break;

        case 'opcode':
          lineText += `${text.val.mnemonic} `;
          break;

        case 'signed':
          if (text.val < 0) {
            lineText += `-0x${(-text.val).toString(16)}`;
          } else {
            lineText += `0x${text.val.toString(16)}`;
          }
          break;

        case 'unsigned':
          lineText += `0x${text.val.toString(16)}`;
          break;

        case 'opaque':
          lineText += text.val;
          break;

        case 'branch-dest':
          lineText += `.L${text.val.toString(16)}`;
          break;

        case 'symbol':
          lineText += (text.val as { demangledName?: string; name: string }).demangledName || text.val.name;
          break;

        case 'addend':
          if (text.val < 0) {
            lineText += `-0x${(-text.val).toString(16)}`;
          } else {
            lineText += `+0x${text.val.toString(16)}`;
          }
          break;

        case 'spacing':
          lineText += ' '.repeat(text.val);
          break;

        case 'eol':
          break;

        default:
          lineText += (text as { val?: unknown })?.val || '';
          break;
      }

      if (segment.padTo > lineText.length) {
        const segmentText = lineText.slice(lineText.lastIndexOf('\n') + 1);
        if (segment.padTo > segmentText.length) {
          lineText += ' '.repeat(segment.padTo - segmentText.length);
        }
      }
    }

    return lineText;
  }
}
