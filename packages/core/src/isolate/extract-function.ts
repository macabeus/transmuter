import { escapeRegex } from '~/rules/helpers.js';

/**
 * Slice the textual definition of a single C function out of a larger source.
 *
 * Returns the original `source` if no definition for `functionName` is found.
 */
export function extractFunctionDefinition(source: string, functionName: string): string {
  // Blank out comments and string/char literals before searching for the
  // function name. Without this, a `funcName(...) {` fragment inside a
  // doc comment or string literal can be picked up and we'd try to
  // brace-balance a "body" that doesn't actually exist. Replacing with
  // spaces preserves byte offsets so the indices we report still point
  // into the original `source`.
  const safe = blankNonCode(source);
  const re = new RegExp(`\\b${escapeRegex(functionName)}\\s*\\(`, 'g');

  // All scanning/walking operates on `safe` (same length, with non-code
  // blanked) so we don't get fooled by parens/braces/keywords inside
  // comments or string literals. Final slicing uses the original `source`.
  let match: RegExpExecArray | null;
  while ((match = re.exec(safe)) !== null) {
    // Walk past the matching ')' for the parameter list. This handles nested
    // parens (function pointer params, casts in default args, etc.).
    let i = match.index + match[0].length - 1;
    let parenDepth = 1;
    while (++i < safe.length && parenDepth > 0) {
      const ch = safe[i];
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
    while (i < safe.length && /\s/.test(safe[i]!)) {
      i++;
    }
    if (safe[i] !== '{') {
      continue;
    }

    // Brace-balance the body. Comments and string literals are already
    // blanked in `safe`, so a simple depth counter suffices.
    let j = i;
    let braceDepth = 1;
    while (++j < safe.length && braceDepth > 0) {
      const ch = safe[j];
      if (ch === '{') {
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
      const ch = safe[s - 1];
      if (ch === '}' || ch === ';') {
        break;
      }
      s--;
    }
    while (s < match.index && /\s/.test(safe[s]!)) {
      s++;
    }

    return source.slice(s, j);
  }

  return source;
}

/**
 * Replace the contents of comments, string literals, and character literals
 * with spaces so a regex / index-walker can't be fooled by code-like text
 * inside them. Length is preserved so resulting indices still map into the
 * original source.
 */
function blankNonCode(source: string): string {
  const out = Array.from(source);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') {
          out[i] = ' ';
        }
        i++;
      }
      if (i + 1 < source.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
    } else if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = ' ';
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (source[i] !== '\n') {
          out[i] = ' ';
        }
        i++;
      }
      if (i < source.length) {
        out[i] = ' ';
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}
