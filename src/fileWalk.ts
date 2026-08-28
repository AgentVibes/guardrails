import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// `.claude` is agent workspace, not product source — and in the wild it holds
// symlinked git worktrees of OTHER repos (observed in observatory), which is
// also why the walker lstats and never follows symlinks: a symlinked foreign
// tree must not leak into this project's metrics or scans.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".git",
  "coverage",
  ".turbo",
  ".claude",
]);

/** Expand file/dir targets into the contained files matching `exts`. Does not follow symlinks. */
export function collectFiles(targets: string[], exts: string[]): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (exts.some((e) => path.endsWith(e))) out.push(path);
      return;
    }
    if (!st.isDirectory()) return;
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      visit(join(path, entry));
    }
  };
  for (const t of targets) visit(t);
  return out;
}
