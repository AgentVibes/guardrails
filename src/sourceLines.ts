export type LineKind = "code" | "blank" | "comment";

/**
 * Line classifier for the LOC metrics. Heuristic on purpose: a `/*` inside a
 * string literal will be misread as opening a comment — acceptable noise for a
 * trend metric, and the same trade every cloc-style counter makes.
 */
export function classifyLines(text: string): LineKind[] {
  const kinds: LineKind[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      kinds.push("comment");
      const close = line.indexOf("*/");
      if (close >= 0 && line.slice(close + 2).trim() !== "") {
        kinds[kinds.length - 1] = "code";
      }
      if (close >= 0) inBlock = false;
      continue;
    }
    if (line === "") {
      kinds.push("blank");
      continue;
    }
    if (line.startsWith("//")) {
      kinds.push("comment");
      continue;
    }
    if (line.startsWith("/*")) {
      kinds.push("comment");
      if (!line.includes("*/")) inBlock = true;
      else if (line.slice(line.indexOf("*/") + 2).trim() !== "") kinds[kinds.length - 1] = "code";
      continue;
    }
    kinds.push("code");
    if (line.includes("/*") && !line.slice(line.indexOf("/*")).includes("*/")) inBlock = true;
  }
  return kinds;
}

/** Count `code` lines within a 1-based inclusive line range. */
export function codeLinesInRange(kinds: LineKind[], startLine: number, endLine: number): number {
  let n = 0;
  for (let i = startLine - 1; i < endLine && i < kinds.length; i++) {
    if (kinds[i] === "code") n++;
  }
  return n;
}
