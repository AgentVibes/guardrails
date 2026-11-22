import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFileSloc, updateFileSloc } from "./fileSlocBaseline.js";
import { packageRoot } from "./packagePaths.js";

// Per-file length ratchet, both directions, executed:
//   - pure functions: creation lists only files over the threshold, a plain
//     update never raises or adds, a shrink tightens, back-under and gone drop,
//     --force re-lists, a rename carries the ceiling;
//   - the CLI in a scratch git repo: `metrics --check` and `verify-diff` go RED
//     when a listed file grows or an unlisted one crosses the limit, stay green
//     at the limit, ignore test files, and fail loudly (exit 2) on a bad
//     threshold. Growth is appended at the END of a file on purpose: the size
//     finding sits at line 1, and a test that edited near line 1 would pass
//     even if verify-diff dropped size findings with its per-line filter.

const cli = join(packageRoot, "dist", "cli.js");
let failures = 0;

function expect(step: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  file-sloc: ${step}`);
    return;
  }
  failures += 1;
  console.error(`FAIL file-sloc: ${step}\n${detail}`);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function unitChecks(): void {
  const measured = new Map([
    ["big.ts", 600],
    ["small.ts", 100],
    ["edge.ts", 500],
  ]);
  const created = updateFileSloc(undefined, measured, 500, false, () => true);
  expect(
    "creation lists only files over the threshold",
    same(created.next.files, { "big.ts": 600 }),
  );

  const grown = updateFileSloc(
    created.next,
    new Map([
      ["big.ts", 650],
      ["new.ts", 900],
    ]),
    500,
    false,
    () => true,
  );
  expect(
    "plain update never raises a ceiling nor lists a new file",
    same(grown.next.files, { "big.ts": 600 }) && grown.held.length === 2,
    JSON.stringify(grown),
  );

  const shrunk = updateFileSloc(created.next, new Map([["big.ts", 550]]), 500, false, () => true);
  expect("a shrink tightens the ceiling", same(shrunk.next.files, { "big.ts": 550 }));

  const under = updateFileSloc(created.next, new Map([["big.ts", 500]]), 500, false, () => true);
  expect(
    "back at the threshold drops the entry",
    same(under.next.files, {}) && same(under.dropped, ["big.ts"]),
  );

  const gone = updateFileSloc(created.next, new Map(), 500, false, () => false);
  const outside = updateFileSloc(created.next, new Map(), 500, false, () => true);
  expect(
    "a deleted file drops, an unmeasured one is kept",
    same(gone.next.files, {}) && same(outside.next.files, { "big.ts": 600 }),
  );

  const forced = updateFileSloc(
    created.next,
    new Map([
      ["big.ts", 650],
      ["new.ts", 900],
    ]),
    500,
    true,
    () => true,
  );
  expect(
    "--force re-lists at current values",
    same(forced.next.files, { "big.ts": 650, "new.ts": 900 }),
  );

  const renames = new Map([["moved.ts", "big.ts"]]);
  const moved = updateFileSloc(
    created.next,
    new Map([["moved.ts", 590]]),
    500,
    false,
    (k) => k !== "big.ts",
    renames,
  );
  expect(
    "a rename carries the ceiling to the new path",
    same(moved.next.files, { "moved.ts": 590 }),
  );
  expect(
    "check: a renamed listed file is judged by its old ceiling",
    checkFileSloc(new Map([["moved.ts", 600]]), { "big.ts": 600 }, 500, renames).length === 0 &&
      checkFileSloc(new Map([["moved.ts", 601]]), { "big.ts": 600 }, 500, renames)[0]?.kind ===
        "grew",
  );
}

const body = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n") + "\n";

function sh(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number; out: string } {
  const res = spawnSync(args[0] ?? "", args.slice(1), {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GUARDRAILS_MAX_FILE_SLOC: "", ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function git(dir: string, ...args: string[]): void {
  const r = sh(dir, ["git", ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
}

function gate(
  dir: string,
  step: string,
  want: { check: number; diff: number },
  env: Record<string, string> = {},
): void {
  const check = sh(dir, ["node", cli, "metrics", "--check"], env);
  const diff = sh(dir, ["node", cli, "verify-diff"], env);
  expect(
    `${step} → metrics --check ${want.check}, verify-diff ${want.diff}`,
    check.status === want.check && diff.status === want.diff,
    `metrics --check exit ${check.status}:\n${check.out}\nverify-diff exit ${diff.status}:\n${diff.out}`,
  );
}

function cliChecks(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  const big = join(dir, "big.ts");
  const small = join(dir, "small.ts");
  writeFileSync(big, body(600, "b"));
  writeFileSync(small, body(100, "s"));
  writeFileSync(join(dir, "big.test.ts"), body(700, "t"));
  const created = sh(dir, ["node", cli, "metrics", "--update-baseline"]);
  const baselineFile = join(dir, ".guardrails", "file-sloc.json");
  const listed = readFileSync(baselineFile, "utf8");
  expect(
    "--update-baseline lists big.ts only (test file excluded)",
    created.status === 0 && listed.includes('"big.ts": 600') && !listed.includes("big.test.ts"),
    `${created.out}\n${listed}`,
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");

  gate(dir, "unchanged tree", { check: 0, diff: 0 });

  writeFileSync(big, body(601, "b"));
  gate(dir, "listed file grows by one line at its end", { check: 1, diff: 1 });
  const held = sh(dir, ["node", cli, "metrics", "--update-baseline"]);
  expect(
    "--update-baseline while grown holds the ceiling",
    held.status === 0 && readFileSync(baselineFile, "utf8").includes('"big.ts": 600'),
    held.out,
  );
  git(dir, "checkout", "-q", "--", ".");

  writeFileSync(small, body(501, "s"));
  gate(dir, "unlisted file crosses the limit", { check: 1, diff: 1 });
  writeFileSync(small, body(500, "s"));
  gate(dir, "unlisted file exactly at the limit", { check: 0, diff: 0 });
  git(dir, "checkout", "-q", "--", ".");

  writeFileSync(join(dir, "big.test.ts"), body(900, "t"));
  gate(dir, "a test file over the limit", { check: 0, diff: 0 });
  git(dir, "checkout", "-q", "--", ".");

  writeFileSync(baselineFile, `${JSON.stringify({ version: 1, threshold: 500, files: {} })}\n`);
  gate(dir, "big.ts unlisted but untouched by the diff", { check: 1, diff: 0 });
  git(dir, "checkout", "-q", "--", ".");

  git(dir, "mv", "big.ts", "moved.ts");
  writeFileSync(join(dir, "moved.ts"), body(600, "b").replace("b0 = 0", "b0 = 100"));
  gate(dir, "renamed listed file, same length, one line edited", { check: 0, diff: 0 });
  writeFileSync(join(dir, "moved.ts"), body(601, "b"));
  gate(dir, "renamed listed file that grew", { check: 1, diff: 1 });
  git(dir, "reset", "-q", "--hard");

  writeFileSync(big, body(550, "b"));
  sh(dir, ["node", cli, "metrics", "--update-baseline"]);
  expect(
    "a shrink tightens the committed ceiling",
    readFileSync(baselineFile, "utf8").includes('"big.ts": 550'),
  );
  writeFileSync(big, body(560, "b"));
  gate(dir, "regrowth past the tightened ceiling", { check: 1, diff: 1 });
  writeFileSync(big, body(400, "b"));
  sh(dir, ["node", cli, "metrics", "--update-baseline"]);
  expect(
    "back under the limit drops the entry",
    !readFileSync(baselineFile, "utf8").includes("big.ts"),
  );
  git(dir, "reset", "-q", "--hard");

  mkdirSync(join(dir, ".agentvibes"));
  writeFileSync(join(dir, ".agentvibes", "project.toml"), "[metrics]\nmax_file_sloc = 50\n");
  writeFileSync(small, body(101, "s"));
  gate(dir, "[metrics] max_file_sloc = 50", { check: 1, diff: 1 });
  gate(
    dir,
    "env GUARDRAILS_MAX_FILE_SLOC=1000 overrides it",
    { check: 0, diff: 0 },
    { GUARDRAILS_MAX_FILE_SLOC: "1000" },
  );
  writeFileSync(join(dir, ".agentvibes", "project.toml"), '[metrics]\nmax_file_sloc = "lots"\n');
  gate(dir, "a non-integer threshold is a usage error", { check: 2, diff: 2 });
  gate(
    dir,
    "a zero threshold is a usage error",
    { check: 2, diff: 2 },
    { GUARDRAILS_MAX_FILE_SLOC: "0" },
  );
}

function main(): number {
  unitChecks();
  const dir = mkdtempSync(join(tmpdir(), "guardrails-file-sloc-"));
  try {
    cliChecks(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`file-sloc: ${failures} step(s) failed`);
    return 1;
  }
  console.log("file-sloc ratchet passed");
  return 0;
}

process.exit(main());
