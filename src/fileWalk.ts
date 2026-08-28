import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".git", "coverage", ".turbo"]);

/** Expand file/dir targets into the contained files matching `exts`. */
export function collectFiles(targets: string[], exts: string[]): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
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
