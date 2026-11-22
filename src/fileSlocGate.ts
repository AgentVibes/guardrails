import { relative } from "node:path";
import { match } from "ts-pattern";
import { dropGitignored, EXCLUDED_FILE, measureFileSloc } from "./fileSloc.js";
import {
  baselineKey,
  checkFileSloc,
  describeViolation,
  FILE_SLOC_RULE,
  fileSlocBaselinePath,
  lengthGated,
  maxFileSloc,
  readFileSlocBaseline,
} from "./fileSlocBaseline.js";
import { collectFiles } from "./fileWalk.js";
import type { Finding } from "./findings.js";
import { renamedFrom as gitRenamedFrom, gitRoot, resolveMergeBase } from "./gitDiff.js";

// verify-diff's side of the per-file length ratchet: measure the files the
// diff touched and turn every violation into an error-tier finding at line 1.

export type SizeScope =
  | { kind: "tree" }
  /** absolute paths; `renamedFrom` maps a renamed file's new path to its old one */
  | { kind: "files"; files: string[]; renamedFrom: Map<string, string> };

const SOURCE_EXTS = [".ts", ".tsx", ".jsx"];

/** Absolute new → old rename pairs as baseline keys. */
function renameKeys(cwd: string, renamedFrom: Map<string, string>): Map<string, string> {
  return new Map(
    [...renamedFrom].map(([to, from]) => [baselineKey(cwd, to), baselineKey(cwd, from)]),
  );
}

/**
 * Renames since the merge base, as baseline keys — for `metrics`, which has no
 * diff of its own. Empty outside git or without a resolvable base.
 */
export function renamesSinceBase(cwd: string): Map<string, string> {
  const root = gitRoot(cwd);
  const mergeBase = root === undefined ? undefined : resolveMergeBase(root);
  if (root === undefined || mergeBase === undefined) return new Map();
  return renameKeys(cwd, gitRenamedFrom(root, mergeBase));
}

function inScope(scope: SizeScope): { files: string[]; renamedFrom: Map<string, string> } {
  return match(scope)
    .with({ kind: "tree" }, () => ({
      files: dropGitignored(collectFiles(["."], SOURCE_EXTS)),
      renamedFrom: new Map<string, string>(),
    }))
    .with({ kind: "files" }, (s) => ({ files: s.files, renamedFrom: s.renamedFrom }))
    .exhaustive();
}

/** Throws FileSlocConfigError on a bad threshold or an unreadable baseline. */
export function fileSlocFindings(
  cwd: string,
  scope: SizeScope,
  exclude: RegExp | undefined,
): Finding[] {
  const threshold = maxFileSloc(cwd);
  const baselinePath = fileSlocBaselinePath(cwd);
  const read = readFileSlocBaseline(baselinePath);
  const baseline = match(read)
    .with({ kind: "absent" }, () => ({}))
    .with({ kind: "present" }, (r) => r.baseline.files)
    .exhaustive();

  const { files, renamedFrom } = inScope(scope);
  const measured = new Map<string, number>();
  const absByKey = new Map<string, string>();
  for (const file of files) {
    if (EXCLUDED_FILE.test(file)) continue;
    if (exclude?.test(relative(cwd, file))) continue;
    match(measureFileSloc(file))
      // A file deleted between the diff and the read has no length to judge.
      .with({ kind: "unreadable" }, () => undefined)
      .with({ kind: "measured" }, ({ sloc }) => {
        const key = baselineKey(cwd, file);
        if (!lengthGated(key)) return;
        measured.set(key, sloc);
        absByKey.set(key, file);
      })
      .exhaustive();
  }

  const baselineRel = baselineKey(cwd, baselinePath);
  const hint = match(read)
    .with(
      { kind: "absent" },
      () =>
        `\n  (no ${baselineRel} yet: \`guardrails metrics --update-baseline\` lists the files already over the limit — commit it)`,
    )
    .with({ kind: "present" }, () => "")
    .exhaustive();
  return checkFileSloc(measured, baseline, threshold, renameKeys(cwd, renamedFrom)).map((v) => ({
    rule: FILE_SLOC_RULE,
    severity: "error" as const,
    file: absByKey.get(v.file) ?? v.file,
    line: 1,
    message: `${describeViolation(v, baselineRel)}${hint}`,
    source: "structure" as const,
  }));
}
