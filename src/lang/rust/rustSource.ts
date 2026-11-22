// A small Rust lexer for the override scanner: enough to find attributes
// without being fooled by comments and string literals. `maskRust` returns
// the text with the CONTENTS of every comment and string literal replaced by
// spaces (newlines kept, quotes kept), so offsets and line numbers are the
// same as in the original and a `#[allow(` inside a string is not code.

function isIdent(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
}

/** End (exclusive) of a raw string starting at `i` (`r`, `br`), or undefined when it is not one. */
function rawStringEnd(text: string, i: number): { open: number; end: number } | undefined {
  let j = i;
  if (text[j] === "b" || text[j] === "c") j++;
  if (text[j] !== "r") return undefined;
  j++;
  let hashes = 0;
  while (text[j] === "#") {
    hashes++;
    j++;
  }
  if (text[j] !== '"') return undefined;
  const close = `"${"#".repeat(hashes)}`;
  const end = text.indexOf(close, j + 1);
  return { open: j, end: end < 0 ? text.length : end + close.length };
}

export function maskRust(text: string): string {
  const chars = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(chars, i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(chars, i, j);
      i = j;
      continue;
    }
    if ((ch === "r" || ch === "b" || ch === "c") && !isIdent(text[i - 1])) {
      const raw = rawStringEnd(text, i);
      if (raw !== undefined) {
        blank(chars, raw.open + 1, raw.end - 1);
        i = raw.end;
        continue;
      }
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      blank(chars, i + 1, Math.min(j, text.length));
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      // A char literal ('x', '\n', '\u{1F600}') or a lifetime ('a). A lifetime
      // has no closing quote right after its first character.
      if (next === "\\") {
        const end = text.indexOf("'", i + 2);
        const stop = end < 0 ? text.length : end;
        blank(chars, i + 1, stop);
        i = stop + 1;
        continue;
      }
      const close = [2, 3].find((k) => text[i + k] === "'");
      if (close !== undefined && next !== "'") {
        blank(chars, i + 1, i + close);
        i += close + 1;
        continue;
      }
    }
    i++;
  }
  return chars.join("");
}

/** Index of the bracket closing the one at `open` (any of ([{), counted on masked text. */
export function closingBracket(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}

/** Top-level comma-separated pieces of `masked[from, to)`, as [start, end) offsets. */
export function splitArgs(masked: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, to]);
  return out.filter(([a, b]) => masked.slice(a, b).trim() !== "");
}

/** 1-based line of an offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** The value of a string literal in `original` (plain or raw), without unescaping beyond `\"`. */
export function stringValue(original: string): string | undefined {
  const t = original.trim();
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(t);
  if (raw !== null) return raw[2];
  const plain = /^"([\s\S]*)"$/.exec(t);
  return plain?.[1]?.replace(/\\"/g, '"');
}
