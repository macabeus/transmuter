import { escapeRegex } from '~/rules/helpers.js';

/**
 * Slice the textual definition of a single C function out of a larger source.
 *
 * Returns the original `source` if no definition for `functionName` is found.
 */
export function extractFunctionDefinition(source: string, functionName: string): string {
  const re = new RegExp(`\\b${escapeRegex(functionName)}\\s*\\(`, 'g');

  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // Walk past the matching ')' for the parameter list. This handles nested
    // parens (function pointer params, casts in default args, etc.).
    let i = match.index + match[0].length - 1;
    let parenDepth = 1;
    while (++i < source.length && parenDepth > 0) {
      const ch = source[i];
      if (ch === '(') {
        parenDepth++;
      } else if (ch === ')') {
        parenDepth--;
      }
    }
    if (parenDepth !== 0) {
      continue;
    }

    // After the param list, a '{' marks a definition; ';' marks a forward
    // declaration; anything else (call site, function pointer init) is noise.
    while (i < source.length && /\s/.test(source[i]!)) {
      i++;
    }
    if (source[i] !== '{') {
      continue;
    }

    // Brace-balance the body. Skip over string literals, char literals, and
    // comments — braces inside those are content, not structural.
    let j = i;
    let braceDepth = 1;
    while (++j < source.length && braceDepth > 0) {
      const ch = source[j];
      const next = source[j + 1];
      if (ch === '"' || ch === "'") {
        // Walk to the matching quote, honoring backslash escapes.
        const quote = ch;
        while (++j < source.length) {
          const c = source[j];
          if (c === '\\') {
            j++;
            continue;
          }
          if (c === quote) {
            break;
          }
        }
      } else if (ch === '/' && next === '/') {
        // Line comment — to end of line.
        j++;
        while (j + 1 < source.length && source[j + 1] !== '\n') {
          j++;
        }
      } else if (ch === '/' && next === '*') {
        // Block comment — to */.
        j++;
        while (j + 1 < source.length && !(source[j] === '*' && source[j + 1] === '/')) {
          j++;
        }
        j++;
      } else if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
      }
    }
    if (braceDepth !== 0) {
      continue;
    }

    // Walk back from the function name to capture the return type and any
    // storage-class / inline keywords. Stop at the previous statement
    // boundary (`}` or `;`) or the start of the file, then trim leading
    // whitespace.
    let s = match.index;
    while (s > 0) {
      const ch = source[s - 1];
      if (ch === '}' || ch === ';') {
        break;
      }
      s--;
    }
    while (s < match.index && /\s/.test(source[s]!)) {
      s++;
    }

    return source.slice(s, j);
  }

  return source;
}
