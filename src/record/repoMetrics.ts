import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { baselineKey, lengthGated, maxFileSloc } from "../fileSlocBaseline.js";
import { collectFiles } from "../fileWalk.js";
import type { ProjectMetrics } from "../metricsTypes.js";

// Whole-repo metrics that only the record needs. `metrics` and `snapshot`
// add them when a run records; none of them is gated. Names are stable API
// (README "Recording"): the projects_latest columns read `sloc`,
// `avg_file_sloc`, `files_over_sloc_limit`, `git_worktrees` and
// `git_local_branches` by exactly these names (METRIC_COLUMNS in schema.ts).

/** File extension → language, for the LOC breakdown. Anything else is not counted. */
export const LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".vue": "vue",
  ".svelte": "svelte",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".sh": "shell",
  ".sql": "sql",
};

/** Bigger files are generated or vendored (bundles, dumps), not written code. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

/**
 * The project's files: tracked plus untracked-but-not-ignored, as git sees
 * them. Outside a git checkout, every file under root (minus the walker's
 * build and dependency directories).
 */
function projectFiles(root: string): string[] {
  const res = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (!res.error && res.status === 0) {
    return res.stdout
      .split("\0")
      .filter((f) => f !== "")
      .map((f) => join(root, f));
  }
  return collectFiles([root], Object.keys(LANGUAGES));
}

/** `loc` (non-blank lines), `loc_files`, and `loc.<language>` for every language present. */
export function locMetrics(root: string): Record<string, number> {
  const out: Record<string, number> = { loc: 0, loc_files: 0 };
  for (const file of projectFiles(root)) {
    const lang = LANGUAGES[extname(file).toLowerCase()];
    if (lang === undefined) continue;
    let text: string;
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > MAX_COUNTED_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      // ast-grep-ignore: catch-empty -- a tracked file deleted in the work tree has no lines to count
      continue;
    }
    let lines = 0;
    for (const line of text.split("\n")) if (line.trim() !== "") lines += 1;
    out.loc = (out.loc ?? 0) + lines;
    out.loc_files = (out.loc_files ?? 0) + 1;
    out[`loc.${lang}`] = (out[`loc.${lang}`] ?? 0) + lines;
  }
  return out;
}

/**
 * The SLOC `metrics` already measured per production file (fileSloc.ts:
 * imports, blank and comment lines excluded): total, mean per file, and how
 * many files exceed the repo's `max_file_sloc`.
 */
export function slocMetrics(m: ProjectMetrics, root: string): Record<string, number> {
  const limit = maxFileSloc(root);
  const sloc = m.files.reduce((sum, f) => sum + f.fileSloc, 0);
  const out: Record<string, number> = {
    sloc,
    // The same files the length ratchet gates, so the two counts agree.
    files_over_sloc_limit: m.files.filter(
      (f) => f.fileSloc > limit && lengthGated(baselineKey(root, f.file)),
    ).length,
  };
  if (m.files.length > 0) out.avg_file_sloc = Math.round((sloc / m.files.length) * 10) / 10;
  return out;
}

function gitCount(root: string, args: string[], line: RegExp): number | undefined {
  const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout.split("\n").filter((l) => line.test(l)).length;
}

/** Open worktrees (the main one included) and local branches; absent outside git. */
export function gitMetrics(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const worktrees = gitCount(root, ["worktree", "list", "--porcelain"], /^worktree /);
  const branches = gitCount(root, ["for-each-ref", "--format=%(refname)", "refs/heads"], /\S/);
  if (worktrees !== undefined) out.git_worktrees = worktrees;
  if (branches !== undefined) out.git_local_branches = branches;
  return out;
}

export function repoMetrics(m: ProjectMetrics, root: string): Record<string, number> {
  return { ...slocMetrics(m, root), ...locMetrics(root), ...gitMetrics(root) };
}
