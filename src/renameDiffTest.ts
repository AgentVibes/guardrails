import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLinesByFile, changedFiles } from "./gitDiff.js";
import { packageRoot } from "./packagePaths.js";

// is-97095d35: verify-diff treated a renamed file as if every line were new,
// because each changed path was diffed ALONE — with only the new path in the
// pathspec git cannot pair the rename. The added-lines computation now runs one
// rename-aware `git diff -U0 -M` and reads per-file hunks.
//
// Three executed directions, because a "fix" that stopped counting added lines
// altogether would be worse than the bug:
//   1. pure rename of a file with a pre-existing violation → zero added lines,
//      verify-diff exit 0 (the inherited violation must NOT gate)
//   2. rename plus one new violating line → exactly that line gates
//   3. ordinary modified file → its added line still gates (regression)

const BASE_SOURCE = `export const keep = 1;
export const inherited = (x: unknown) => x as any;
export const tail = 3;
`;
const NEW_VIOLATION = "export const fresh = (x: unknown) => x as any;\n";

const INHERITED_LINE = 2;
const ADDED_LINE = 4;

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function expectStep(step: string, ok: boolean, detail: string): boolean {
  if (!ok) {
    console.error(`FAIL rename-diff: ${step}\n${detail}`);
    return false;
  }
  console.log(`  ok  rename-diff: ${step}`);
  return true;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * A repo whose one commit holds BASE_SOURCE plus a same-commit `origin/main`
 * ref, so verify-diff resolves the added-lines rung against it (a bare local
 * branch sitting at HEAD is rejected as degenerate by resolveMergeBase).
 */
function seedRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "original.ts"), BASE_SOURCE);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  const base = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "update-ref", "refs/remotes/origin/main", base);
  return base;
}

function verifyDiff(dir: string): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "verify-diff"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-rename-diff-"));
  try {
    // 1. pure rename — no content change at all.
    const pure = join(dir, "pure");
    const pureBase = seedRepo(pure);
    if (!readFileSync(join(pure, "original.ts"), "utf8").includes("as any")) {
      console.error("FAIL rename-diff: fixture is inert — the base file carries no violation");
      return 1;
    }
    git(pure, "mv", "original.ts", "pure.ts");
    const pureAdded = addedLinesByFile(pure, pureBase).get(join(pure, "pure.ts"));
    const pureTracked = changedFiles(pure, pureBase).tracked.includes(join(pure, "pure.ts"));
    if (
      !expectStep(
        "pure rename → still tracked, zero added lines",
        pureTracked && pureAdded?.size === undefined,
        `tracked=${pureTracked} added=${pureAdded === undefined ? "absent" : [...pureAdded].join(",")}`,
      )
    ) {
      return 1;
    }
    const pureRun = verifyDiff(pure);
    if (
      !expectStep(
        "pure rename of a violating file → verify-diff exit 0",
        pureRun.status === 0,
        pureRun.out,
      )
    ) {
      return 1;
    }

    // 2. rename plus one new violating line appended.
    const moved = join(dir, "moved");
    const movedBase = seedRepo(moved);
    git(moved, "mv", "original.ts", "modified.ts");
    writeFileSync(join(moved, "modified.ts"), BASE_SOURCE + NEW_VIOLATION);
    const movedAdded = addedLinesByFile(moved, movedBase).get(join(moved, "modified.ts"));
    if (
      !expectStep(
        "rename + one added violation → exactly line 4 added",
        movedAdded?.size === 1 && movedAdded.has(ADDED_LINE),
        `added=${movedAdded === undefined ? "absent" : [...movedAdded].join(",")}`,
      )
    ) {
      return 1;
    }
    const movedRun = verifyDiff(moved);
    if (
      !expectStep(
        "rename + one added violation → verify-diff reports exactly that line",
        movedRun.status === 1 &&
          movedRun.out.includes(`modified.ts:${ADDED_LINE}`) &&
          !movedRun.out.includes(`modified.ts:${INHERITED_LINE}`) &&
          countOf(movedRun.out, "error[") === 1,
        movedRun.out,
      )
    ) {
      return 1;
    }

    // 3. ordinary modified file — the regression direction.
    const mod = join(dir, "modified");
    const modBase = seedRepo(mod);
    writeFileSync(join(mod, "original.ts"), BASE_SOURCE + NEW_VIOLATION);
    const modAdded = addedLinesByFile(mod, modBase).get(join(mod, "original.ts"));
    if (
      !expectStep(
        "ordinary modified file → still reports its added line",
        modAdded?.size === 1 && modAdded.has(ADDED_LINE),
        `added=${modAdded === undefined ? "absent" : [...modAdded].join(",")}`,
      )
    ) {
      return 1;
    }
    const modRun = verifyDiff(mod);
    if (
      !expectStep(
        "ordinary modified file → verify-diff exit 1 on the new line only",
        modRun.status === 1 &&
          modRun.out.includes(`original.ts:${ADDED_LINE}`) &&
          !modRun.out.includes(`original.ts:${INHERITED_LINE}`) &&
          countOf(modRun.out, "error[") === 1,
        modRun.out,
      )
    ) {
      return 1;
    }

    // 4. an added line whose text starts with `++ ` prints as `+++ …` inside a
    //    -U0 hunk; it must count as an added line, not as a new file header.
    const plus = join(dir, "plus");
    const plusBase = seedRepo(plus);
    //    It only bites when a LATER hunk follows it, so it goes after line 1 and
    //    a second, separate hunk is appended at the end: lines 2 and 5.
    const [first, ...rest] = BASE_SOURCE.split("\n");
    writeFileSync(
      join(plus, "original.ts"),
      `${first}\n++ not a header\n${rest.join("\n")}export const after = 5;\n`,
    );
    const plusAdded = addedLinesByFile(plus, plusBase);
    const plusLines = plusAdded.get(join(plus, "original.ts"));
    if (
      !expectStep(
        "added line starting with `++ ` → counted in its own file, no phantom file",
        plusAdded.size === 1 && plusLines?.size === 2 && plusLines.has(2) && plusLines.has(5),
        `files=${[...plusAdded.keys()].join(",")} added=${plusLines === undefined ? "absent" : [...plusLines].join(",")}`,
      )
    ) {
      return 1;
    }

    console.log("rename-diff fixtures passed");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
