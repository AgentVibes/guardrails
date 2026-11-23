import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectOverrides } from "./overrides.js";
import { packageRoot, packageVersion } from "./packagePaths.js";
import { gitMetrics, locMetrics } from "./record/repoMetrics.js";

// `guardrails snapshot` (snapshot.ts) and the record-only metrics
// (record/repoMetrics.ts). The red cases: a snapshot must not write into the
// repo it observes; a repo whose guardrails setup is broken or absent must
// still be recorded (wiring off, metrics present), not fail; a database that
// cannot be written must fail the snapshot, because recording is its job.

const CLI = join(packageRoot, "dist", "cli.js");
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `\n  ${detail}`}`);
}

function rows(db: string, sql: string): Record<string, unknown>[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    d.close();
  }
}

function git(dir: string, ...args: string[]) {
  return spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args],
    {
      encoding: "utf8",
    },
  );
}

function repo(tree: Record<string, string>, origin = "git@example.com:demo/plain.git"): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-snapshot-"));
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function listing(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(relative(dir, p));
      if (e.isDirectory()) visit(p);
    }
  };
  visit(dir);
  return out.sort();
}

function snapshot(cwd: string, args: string[], env: Record<string, string>) {
  return spawnSync("node", [CLI, "snapshot", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const PLAIN = {
  ".gitignore": "gen/\n",
  "src/a.ts": "export function f(x: number) {\n  return x + 1;\n}\n",
  "src/b.tsx": "export const B = () => <div />;\n",
  "src/style.css": "body {\n\n  margin: 0;\n}\n",
  "gen/out.ts": "// ast-grep-ignore\nexport const generated = 1;\n",
};

function plainRepoCases(): void {
  const dir = repo(PLAIN);
  // The ignored file exists in the work tree only, as generated code does.
  mkdirSync(join(dir, "gen"), { recursive: true });
  writeFileSync(join(dir, "gen", "out.ts"), "// ast-grep-ignore\nexport const generated = 1;\n");
  const state = mkdtempSync(join(tmpdir(), "guardrails-snapshot-state-"));
  try {
    const before = listing(dir);
    const statusBefore = git(dir, "status", "--porcelain", "--ignored").stdout;
    // Unset GUARDRAILS_RECORD: snapshot still records, to the default database.
    const res = snapshot(dir, [], { XDG_STATE_HOME: state });
    const db = join(state, "agentvibes", "guardrails.sqlite");
    check(
      "snapshot with GUARDRAILS_RECORD unset records to the default database",
      res.status === 0 && existsSync(db),
      res.stderr,
    );
    check(
      "snapshot writes nothing into the observed repo",
      JSON.stringify(listing(dir)) === JSON.stringify(before) &&
        git(dir, "status", "--porcelain", "--ignored").stdout === statusBefore,
      `${JSON.stringify(before)} → ${JSON.stringify(listing(dir))}`,
    );
    const p = rows(db, "SELECT * FROM projects_latest")[0];
    check(
      "a repo without guardrails is wiring off, with findings, overrides and metrics",
      p?.key === "example.com/demo/plain" &&
        p.wiring === "off" &&
        p.wiring_installed === 0 &&
        p.errors !== null &&
        p.overrides === 0 &&
        typeof p.sloc === "number" &&
        p.files === 2 &&
        p.worktrees === 1 &&
        p.local_branches === 1 &&
        p.last_command === "snapshot",
      JSON.stringify(p),
    );
    const loc = Object.fromEntries(
      rows(db, "SELECT metric, value FROM metric_history WHERE metric LIKE 'loc%'").map((r) => [
        r.metric,
        r.value,
      ]),
    );
    check(
      "LOC by language counts non-blank lines of tracked and untracked files, not ignored ones",
      loc["loc.typescript"] === 3 && loc["loc.tsx"] === 1 && loc["loc.css"] === 3 && loc.loc === 7,
      JSON.stringify(loc),
    );

    // A relative GUARDRAILS_RECORD means the directory it was typed in, not the repo.
    const here = mkdtempSync(join(tmpdir(), "guardrails-snapshot-cwd-"));
    try {
      const rel = snapshot(here, [dir], { GUARDRAILS_RECORD: "out/g.sqlite" });
      check(
        "a relative database path resolves where the command was typed",
        rel.status === 0 &&
          existsSync(join(here, "out", "g.sqlite")) &&
          !existsSync(join(dir, "out")),
        rel.stderr,
      );
    } finally {
      rmSync(here, { recursive: true, force: true });
    }

    // RED: recording is the snapshot's whole job, so a failed write fails it.
    const blocker = join(state, "a-file");
    writeFileSync(blocker, "");
    const bad = snapshot(dir, [], { GUARDRAILS_RECORD: join(blocker, "g.sqlite") });
    check(
      "an unwritable database fails the snapshot with exit 2",
      bad.status === 2 && /recording snapshot to .* failed/.test(bad.stderr),
      `status ${bad.status} ${bad.stderr}`,
    );
    check("a missing path is exit 2", snapshot(dir, [join(dir, "nope")], {}).status === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}

const WIRED = {
  "package.json": `${JSON.stringify({ name: "x", scripts: { lint: "guardrails verify ." } })}\n`,
  "src/a.ts": "export const a = (x: unknown) => x as any;\n",
};

function canonFallbackCases(): void {
  // A wired repo whose dependencies were never installed: its sgconfig.yml
  // lists node_modules/@agentvibes/guardrails/rules, which does not exist. The
  // scan uses the running package's rules instead and says so.
  const dir = repo({
    ...WIRED,
    "sgconfig.yml": "ruleDirs:\n  - node_modules/@agentvibes/guardrails/rules\n",
  });
  const before = listing(dir);
  const state = mkdtempSync(join(tmpdir(), "guardrails-snapshot-state-"));
  const db = join(state, "g.sqlite");
  try {
    const res = snapshot(dir, ["--json"], { GUARDRAILS_RECORD: db });
    const out = JSON.parse(res.stdout || "{}") as { parts?: string[]; notes?: string[] };
    const note = out.notes?.[0] ?? "";
    check(
      "a missing canon dir is scanned with the running package's rules",
      res.status === 0 &&
        (out.parts ?? []).some((p) => /^findings [1-9]\d* error\(s\)/.test(p)) &&
        note.includes("node_modules/@agentvibes/guardrails/rules") &&
        note.includes(`@agentvibes/guardrails ${packageVersion()}`),
      `${res.stdout} ${res.stderr}`,
    );
    const r = rows(db, "SELECT languages, errors, guardrails_version FROM runs")[0];
    check(
      "the fallback run records its languages, errors and the running version",
      r?.languages === "typescript" &&
        Number(r.errors) >= 1 &&
        r.guardrails_version === packageVersion(),
      JSON.stringify(r),
    );
    check(
      "the fallback writes nothing into the observed repo",
      JSON.stringify(listing(dir)) === JSON.stringify(before),
    );
    const verify = spawnSync("node", [CLI, "verify", "--json"], { cwd: dir, encoding: "utf8" });
    check(
      "verify takes the same fallback, says so and gates on the canon finding",
      verify.status === 1 &&
        /as-any-escape/.test(verify.stdout) &&
        /scanned with the rules of the running @agentvibes\/guardrails/.test(verify.stderr),
      `${verify.status} ${verify.stdout.slice(0, 300)} ${verify.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}

function brokenSetupCases(): void {
  // A repo-local rule dir that does not exist is not the canon: no fallback,
  // ast-grep cannot load the config. The other parts must still be recorded,
  // and so must the languages and a TypeScript row with the reason.
  const dir = repo({
    ...WIRED,
    "sgconfig.yml":
      "ruleDirs:\n  - node_modules/@agentvibes/guardrails/rules\n  - .ast-grep/rules\n",
  });
  const state = mkdtempSync(join(tmpdir(), "guardrails-snapshot-state-"));
  const db = join(state, "g.sqlite");
  try {
    const res = snapshot(dir, [], { GUARDRAILS_RECORD: db });
    const parts = Object.fromEntries(
      rows(db, "SELECT part, status FROM run_parts WHERE language IS NULL").map((r) => [
        r.part,
        r.status,
      ]),
    );
    const p = rows(
      db,
      "SELECT wiring, wiring_sgconfig_canon, errors, sloc, languages, findings_unavailable FROM projects_latest",
    )[0];
    check(
      "a broken setup records findings unavailable and the other parts measured",
      res.status === 0 &&
        parts.findings === "unavailable" &&
        parts.wiring === "measured" &&
        parts.metrics === "measured" &&
        parts.overrides === "measured" &&
        p?.wiring === "partial" &&
        p.wiring_sgconfig_canon === 1 &&
        p.errors === null &&
        p.sloc === 1,
      `${JSON.stringify(parts)} ${JSON.stringify(p)} ${res.stdout} ${res.stderr}`,
    );
    const reason = rows(
      db,
      "SELECT reason FROM run_parts WHERE part = 'findings' AND language IS NULL",
    )[0]?.reason;
    check(
      "the whole-run part keeps the ast-grep reason, not a per-language one",
      typeof reason === "string" && /^ast-grep exited 6/.test(reason),
      String(reason),
    );
    const run = rows(db, "SELECT languages FROM runs")[0];
    check(
      "the languages are recorded although the findings are unavailable",
      run?.languages === "typescript" && p?.languages === "typescript",
      `${JSON.stringify(run)} ${JSON.stringify(p)}`,
    );
    const ts = rows(
      db,
      "SELECT status, reason FROM run_parts WHERE part = 'findings' AND language = 'typescript'",
    )[0];
    check(
      "the TypeScript failure is recorded per language with its reason",
      ts?.status === "unavailable" && ts.reason === reason,
      JSON.stringify(ts),
    );
    check(
      "projects_latest.findings_unavailable names the TypeScript failure",
      typeof p?.findings_unavailable === "string" &&
        p.findings_unavailable === `typescript: ${String(reason)}`,
      String(p?.findings_unavailable),
    );
    check("no fallback note for a repo-local dir", !/scanned with the rules/.test(res.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}

function unitCases(): void {
  const dir = repo(PLAIN);
  mkdirSync(join(dir, "gen"), { recursive: true });
  writeFileSync(join(dir, "gen", "out.ts"), "// ast-grep-ignore\nexport const generated = 1;\n");
  const walk = mkdtempSync(join(tmpdir(), "guardrails-snapshot-walk-"));
  try {
    git(dir, "branch", "second");
    const g = gitMetrics(dir);
    check(
      "git metrics count local branches and worktrees",
      g.git_local_branches === 2 && g.git_worktrees === 1,
      JSON.stringify(g),
    );
    check("outside git there are no git metrics", Object.keys(gitMetrics(walk)).length === 0);
    writeFileSync(join(walk, "x.py"), "a = 1\n\nb = 2\n");
    check("outside git LOC walks the directory", locMetrics(walk)["loc.python"] === 2);
    check(
      "a suppression in a gitignored file is not an override",
      collectOverrides(dir).overrides.length === 0,
      JSON.stringify(collectOverrides(dir).overrides),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(walk, { recursive: true, force: true });
  }
}

function main(): number {
  unitCases();
  plainRepoCases();
  canonFallbackCases();
  brokenSetupCases();
  if (failed > 0) {
    console.error(`\n${failed} snapshot check(s) failed`);
    return 1;
  }
  console.log("\nsnapshot passed");
  return 0;
}

process.exitCode = main();
