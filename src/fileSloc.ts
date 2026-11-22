import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ImportDeclaration, Program } from "oxc-parser";
import { isKind, type ParsedFile, parseFile } from "./oxcAst.js";
import { classifyLines } from "./sourceLines.js";

// One definition of "a file's SLOC" for the whole toolkit: `metrics` reports
// it, and the per-file length ratchet (fileSlocBaseline.ts) gates it from both
// `metrics --check` and `verify-diff`. SLOC = lines minus imports, blank lines
// and comment-only lines.

/**
 * Production code only — tests, stories, showcases and declaration files are
 * out of every metric and out of the length ratchet. Same exclusions the
 * original audit used, so numbers stay comparable to its baselines.
 */
export const EXCLUDED_FILE = /\.(test|spec|stories)\.[jt]sx?$|__tests__|\/showcase\/|\.d\.ts$/;

/**
 * Metrics describe the PROJECT — its tracked source — so gitignored files
 * (generated code, local build output) are dropped. Without this the numbers
 * depend on which machine ran them: a fresh CI checkout has no generated
 * files, a dev tree does, and the p90s disagree (observed: p90ContextCost
 * 20 locally vs 21 in CI on the same commit). The ast-grep-backed counters
 * were already deterministic — ast-grep honors .gitignore natively.
 */
export function dropGitignored(files: string[]): string[] {
  if (files.length === 0) return files;
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    input: files.join("\n"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Outside a repo (or git missing) there is no ignore standard to apply.
  if (res.error || res.status === null || res.status > 1) return files;
  const ignored = new Set(res.stdout.split("\n").filter((l) => l !== ""));
  return files.filter((f) => !ignored.has(f));
}

export function importDecls(program: Program): ImportDeclaration[] {
  return program.body.filter((stmt): stmt is ImportDeclaration =>
    isKind(stmt, "ImportDeclaration"),
  );
}

function importLineSet(file: ParsedFile): Set<number> {
  const lines = new Set<number>();
  for (const stmt of importDecls(file.program)) {
    const start = file.lineAt(stmt.start);
    const end = file.lineAt(stmt.end);
    for (let l = start; l <= end; l++) lines.add(l);
  }
  return lines;
}

/** SLOC of an already-parsed file: code lines that are not part of an import. */
export function slocOf(parsed: ParsedFile, text: string): number {
  const importLines = importLineSet(parsed);
  let sloc = 0;
  classifyLines(text).forEach((k, i) => {
    if (k === "code" && !importLines.has(i + 1)) sloc += 1;
  });
  return sloc;
}

export type FileSlocRead = { kind: "measured"; sloc: number } | { kind: "unreadable" };

/** Read, parse and count one file. A deleted or unreadable file is its own state, not 0. */
export function measureFileSloc(file: string): FileSlocRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { kind: "unreadable" };
  }
  return { kind: "measured", sloc: slocOf(parseFile(file, text), text) };
}
