import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

function absPath(root: string, f: string): string {
  return isAbsolute(f) ? f : join(root, f);
}

function git(root: string | undefined, args: string[]): string | undefined {
  const res = spawnSync("git", root === undefined ? args : ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0 || res.error) return undefined;
  return res.stdout;
}

export function gitRoot(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
}

/**
 * The base-ref ladder, ported from defensive-errors hook-postedit.sh.
 * `origin/HEAD` first because it names the remote's real default branch. A
 * LOCAL branch whose merge-base is HEAD itself is rejected: on a repo with no
 * remote, checked out on `main`, the ref `main` IS HEAD — the diff would
 * degenerate to `git diff HEAD` and committing mid-session would launder the
 * findings. A remote ref in the same position is fine: it does not move on a
 * local commit, so the degenerate case self-heals on the next commit.
 */
export function resolveMergeBase(root: string, explicitBase?: string): string | undefined {
  const headOid = git(root, ["rev-parse", "HEAD"])?.trim();
  if (headOid === undefined) return undefined;

  const originHead = git(root, [
    "symbolic-ref",
    "-q",
    "--short",
    "refs/remotes/origin/HEAD",
  ])?.trim();
  const candidates =
    explicitBase !== undefined
      ? [explicitBase]
      : [
          originHead,
          "origin/main",
          "origin/master",
          "upstream/main",
          "upstream/master",
          "main",
          "master",
        ];

  for (const ref of candidates) {
    if (ref === undefined || ref === "") continue;
    if (git(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]) === undefined) continue;
    const mb = git(root, ["merge-base", "HEAD", ref])?.trim();
    if (mb === undefined || mb === "") continue;
    const isRemote = ref.includes("/");
    if (!isRemote && mb === headOid && explicitBase === undefined) continue;
    return mb;
  }
  return undefined;
}

/** Changed (ACMR) tracked .ts/.tsx files vs the merge base, plus untracked ones. Absolute paths. */
export function changedFiles(
  root: string,
  mergeBase: string,
): { tracked: string[]; untracked: string[] } {
  const tracked = (
    git(root, ["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "--", "*.ts", "*.tsx"]) ?? ""
  )
    .split("\n")
    .filter((f) => f !== "")
    .map((f) => absPath(root, f));
  const untracked = (
    git(root, ["ls-files", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"]) ?? ""
  )
    .split("\n")
    .filter((f) => f !== "")
    .map((f) => absPath(root, f));
  return { tracked, untracked };
}

/**
 * 1-based line numbers ADDED in the working tree vs mergeBase, per file.
 *
 * ONE rename-aware diff (`-M`) for all .ts/.tsx paths is parsed, not one diff
 * per file. Diffing a renamed file alone hands git only its new path, so it
 * cannot pair the rename and reports every line as added; with both paths in
 * the same diff a 100%-similarity rename produces no hunks at all and a
 * rename-with-edits produces hunks only for the lines that actually changed.
 *
 * Keyed by ABSOLUTE path (like changedFiles). A file with no added lines — a
 * pure rename, a deletion — is absent rather than mapped to an empty set.
 */
export function addedLinesByFile(root: string, mergeBase: string): Map<string, Set<number>> {
  const out = git(root, ["diff", "-U0", "-M", mergeBase, "--", "*.ts", "*.tsx"]) ?? "";
  const byFile = new Map<string, Set<number>>();
  let file: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      // git appends a tab when the path contains whitespace; a pure rename has
      // no `+++` line at all, which is what leaves its target absent.
      const p = line.slice(4).replace(/\t$/, "");
      file = p === "/dev/null" ? undefined : absPath(root, p.replace(/^b\//, ""));
      continue;
    }
    if (file === undefined || !line.startsWith("@@")) continue;
    const m = line.match(/\+(\d+)(?:,(\d+))?/);
    if (m === null) continue;
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    let lines = byFile.get(file);
    if (lines === undefined) {
      lines = new Set<number>();
      byFile.set(file, lines);
    }
    for (let i = 0; i < len; i++) lines.add(start + i);
  }
  return byFile;
}

/**
 * 1-based line numbers ADDED in the working tree vs mergeBase for one file.
 * "No added lines" and "file absent from the diff" are both the empty set.
 */
export function addedLines(root: string, mergeBase: string, file: string): Set<number> {
  return addedLinesByFile(root, mergeBase).get(absPath(root, file)) ?? new Set<number>();
}
