import "./testIsolation.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Finding } from "./findings.js";
import type { Override } from "./overrides.js";
import { packageRoot } from "./packagePaths.js";
import { RecordConfigError, recordTarget } from "./record/config.js";
import { parseRemote } from "./record/repoKey.js";
import type { RunRecord } from "./record/runRecord.js";
import { FACET_TABLES, SCHEMA_VERSION } from "./record/schema.js";
import { openDatabase, RecordSchemaError, writeRun } from "./record/writer.js";
import type { WiringReport } from "./wiring.js";

// Recording (src/record/). Pure parts first (target resolution, repo key),
// then the writer on records built by hand, then the CLI end to end.
//
// The red cases: a partial run (hook-stop's diff, a metrics-only run) must
// NOT wipe what a full run measured; a database that cannot be written must
// NOT change a gate's exit code; a newer schema must be refused, not written.

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

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `guardrails-record-${prefix}-`));
}

function rows(db: string, sql: string): Record<string, unknown>[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------- target

function targetCases(): void {
  const home = "/home/someone";
  const base = { HOME: home };
  const t = (env: Record<string, string>, force = false) =>
    JSON.stringify(recordTarget({ ...base, ...env }, force));
  check("unset is off", t({}) === JSON.stringify({ status: "off" }));
  check('"0" is off', t({ GUARDRAILS_RECORD: "0" }) === JSON.stringify({ status: "off" }));
  check('"" is off', t({ GUARDRAILS_RECORD: "" }) === JSON.stringify({ status: "off" }));
  check(
    '"1" is the default under ~/.local/state',
    t({ GUARDRAILS_RECORD: "1" }) ===
      JSON.stringify({
        status: "on",
        db: `${home}/.local/state/agentvibes/guardrails.sqlite`,
        source: "default",
      }),
    t({ GUARDRAILS_RECORD: "1" }),
  );
  check(
    '"1" honours an absolute XDG_STATE_HOME and ignores a relative one',
    t({ GUARDRAILS_RECORD: "1", XDG_STATE_HOME: "/state" }).includes('"/state/agentvibes/') &&
      t({ GUARDRAILS_RECORD: "1", XDG_STATE_HOME: "rel" }).includes(`${home}/.local/state/`),
  );
  check(
    "a path is that database, ~/ expanded",
    t({ GUARDRAILS_RECORD: "~/g.sqlite" }) ===
      JSON.stringify({ status: "on", db: `${home}/g.sqlite`, source: "env-path" }),
  );
  check("snapshot (force) records even when unset", t({}, true).includes('"source":"default"'));

  const cfg = tmp("cfg");
  try {
    mkdirSync(join(cfg, "agentvibes"));
    writeFileSync(join(cfg, "agentvibes", "guardrails.toml"), '[record]\ndb = "~/x/r.sqlite"\n');
    check(
      "[record] db from the user config, ~/ expanded",
      t({ GUARDRAILS_RECORD: "1", XDG_CONFIG_HOME: cfg }) ===
        JSON.stringify({ status: "on", db: `${home}/x/r.sqlite`, source: "config" }),
    );
    check(
      "an explicit path beats the config",
      t({ GUARDRAILS_RECORD: "/p.sqlite", XDG_CONFIG_HOME: cfg }).includes('"env-path"'),
    );
    writeFileSync(join(cfg, "agentvibes", "guardrails.toml"), "[record]\ndatabase = 1\n");
    let threw = false;
    try {
      recordTarget({ ...base, GUARDRAILS_RECORD: "1", XDG_CONFIG_HOME: cfg });
    } catch (err) {
      threw = err instanceof RecordConfigError;
    }
    check("an unknown [record] key is an error, not ignored", threw);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- repo key

function repoKeyCases(): void {
  const cases: [string, string | undefined][] = [
    ["https://github.com/Owner/Repo.git", "github.com/owner/repo"],
    ["https://x-access-token:secret@github.com/owner/repo", "github.com/owner/repo"],
    ["https://user@gitlab.example.com:8443/owner/repo.git/", "gitlab.example.com/owner/repo"],
    ["git@github.com:owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@git.example.com:2222/owner/repo.git", "git.example.com/owner/repo"],
    ["https://gitlab.com/group/sub/deeper/repo.git", "gitlab.com/group/sub/deeper/repo"],
    ["git@gitlab.com:group/sub/repo.git", "gitlab.com/group/sub/repo"],
    ["/srv/git/repo.git", undefined],
    ["https://github.com/repo", undefined],
  ];
  for (const [url, want] of cases) {
    const p = parseRemote(url);
    const got = p === undefined ? undefined : `${p.host}/${p.owner}/${p.name}`;
    check(`remote ${url} → ${want ?? "no key"}`, got === want, `got ${got}`);
  }
  const sub = parseRemote("https://gitlab.com/group/sub/repo");
  check("a subgroup owner keeps its slashes", sub?.owner === "group/sub" && sub.name === "repo");
}

// ---------------------------------------------------------------- writer

const finding = (
  rule: string,
  severity: Finding["severity"],
  source: Finding["source"] = "ast-grep",
): Finding => ({
  rule,
  severity,
  file: "src/a.ts",
  line: 3,
  message: `${rule} message`,
  source,
});

const override: Override = {
  kind: "ast-grep-ignore",
  rule: "catch-empty",
  where: "src/a.ts:2",
  file: "src/a.ts",
  line: 2,
  reason: { status: "given", text: "cleanup may fail" },
};
const bare: Override = { ...override, where: "src/a.ts:9", line: 9, reason: { status: "missing" } };

const wiring: WiringReport = {
  state: "partial",
  checks: [
    { id: "installed", status: "pass", detail: "^0.2.8" },
    { id: "sgconfig-canon", status: "pass", detail: "ok" },
    { id: "lint-script", status: "pass", detail: "ok" },
    { id: "ci", status: "pass", detail: "ok" },
    { id: "hook-postedit", status: "pass", detail: "ok" },
    { id: "hook-stop", status: "fail", detail: "no Stop hook" },
    { id: "preset", status: "pass", detail: "ok" },
  ],
  overrides: { status: "counted", total: 2, withoutReason: 1 },
};

function record(over: Partial<RunRecord>): RunRecord {
  return {
    repo: { key: "example.com/acme/app", host: "example.com", owner: "acme", name: "app" },
    root: "/work/app",
    command: "verify",
    at: "2026-11-22T10:00:00.000Z",
    sha: "a".repeat(40),
    branch: "main",
    durationMs: 1234.4,
    exitCode: 1,
    tools: { guardrails: "0.2.8", node: "v24.0.0", astGrep: "ast-grep 0.45.2", biome: undefined },
    findings: { status: "skipped" },
    overrides: { status: "skipped" },
    wiring: { status: "skipped" },
    metrics: { status: "skipped" },
    ...over,
  };
}

const FULL = record({
  findings: {
    status: "measured",
    scope: "full",
    data: {
      tiers: "all",
      list: [
        finding("warn-rule", "warning"),
        finding("err-rule", "error"),
        finding("err-rule", "error"),
        finding("canon-overridden", "warning", "override"),
      ],
    },
  },
  overrides: { status: "measured", scope: "full", data: [override, bare] },
  wiring: { status: "measured", scope: "full", data: wiring },
  metrics: { status: "measured", scope: "full", data: { runInActionCount: 4, sloc: 900 } },
});

// RED for the hosted-CI flake (1 of 6 concurrent first runs not recorded):
// switching a new file to WAL while another connection holds the write lock.
// SQLite skips busy_timeout for that step, so before the fix openDatabase
// failed with "database is locked" after ~0 ms. Another process holds
// BEGIN IMMEDIATE on a rollback-journal file for HOLD_MS, the way a racing
// first writer holds it mid-switch; openDatabase must wait and succeed.
async function walSwitchCase(): Promise<void> {
  const dir = tmp("wal");
  const db = join(dir, "g.sqlite");
  const HOLD_MS = 300;
  const seed = new DatabaseSync(db);
  seed.exec("CREATE TABLE seed(x)");
  seed.close();
  const holder = spawn(
    "node",
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const d = new DatabaseSync(${JSON.stringify(db)});
       d.exec("BEGIN IMMEDIATE");
       console.log("locked");
       setTimeout(() => { d.exec("COMMIT"); d.close(); }, ${HOLD_MS});`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise<void>((done) => holder.on("close", () => done()));
  try {
    await new Promise<void>((done, fail) => {
      holder.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("locked")) done();
      });
      holder.on("close", () => fail(new Error("lock holder exited before locking")));
    });
    const t0 = Date.now();
    const outcome = await openDatabase(db).then(
      (h) => {
        const mode = h.prepare("PRAGMA journal_mode").get()?.journal_mode;
        h.close();
        return `ok ${String(mode)}`;
      },
      (err: Error) => `failed: ${err.message}`,
    );
    const waited = Date.now() - t0;
    check(
      "openDatabase waits out a writer that holds the lock during the WAL switch",
      outcome === "ok wal" && waited >= HOLD_MS / 2,
      `${outcome} after ${waited} ms`,
    );
  } finally {
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function writerCases(): Promise<void> {
  const dir = tmp("writer");
  const db = join(dir, "nested", "g.sqlite");
  try {
    const h = await openDatabase(db);
    const first = writeRun(h, FULL);
    check("the parent directory is created", existsSync(db));

    const latest = (): Record<string, unknown> =>
      rows(db, "SELECT * FROM projects_latest")[0] ?? {};
    const p = latest();
    check(
      "a full run fills projects_latest",
      p.wiring === "partial" &&
        p.wiring_hook_stop === 0 &&
        p.wiring_installed === 1 &&
        p.errors === 2 &&
        p.warnings === 1 &&
        p.overrides === 2 &&
        p.overrides_without_reason === 1 &&
        p.run_in_action === 4 &&
        p.sloc === 900 &&
        p.files === null &&
        p.findings_run_id === first,
      JSON.stringify(p),
    );
    check(
      "override findings stay out of findings_latest",
      rows(db, "SELECT rule FROM findings_latest").length === 3,
    );
    check(
      "a missing reason is NULL with has_reason 0",
      JSON.stringify(
        rows(db, 'SELECT "where", reason, has_reason FROM overrides_latest ORDER BY line'),
      ) ===
        JSON.stringify([
          { where: "src/a.ts:2", reason: "cleanup may fail", has_reason: 1 },
          { where: "src/a.ts:9", reason: null, has_reason: 0 },
        ]),
    );
    check(
      "rule counts include override findings by source",
      rows(db, "SELECT * FROM run_rule_counts WHERE rule = 'err-rule' AND count = 2").length ===
        1 && rows(db, "SELECT * FROM run_rule_counts WHERE source = 'override'").length === 1,
    );

    // RED: a diff run (hook-stop) sees one error and no warnings; it must not
    // replace the full run's counts, findings, overrides or wiring.
    writeRun(
      h,
      record({
        command: "hook-stop",
        at: "2026-11-22T11:00:00.000Z",
        exitCode: 0,
        findings: {
          status: "measured",
          scope: "diff",
          data: { tiers: "error-only", list: [finding("err-rule", "error")] },
        },
      }),
    );
    const afterDiff = latest();
    check(
      "a diff run leaves the full run's latest rows alone",
      afterDiff.errors === 2 &&
        afterDiff.warnings === 1 &&
        afterDiff.wiring === "partial" &&
        afterDiff.overrides === 2 &&
        afterDiff.findings_run_id === first &&
        rows(db, "SELECT * FROM findings_latest").length === 3 &&
        afterDiff.last_command === "hook-stop" &&
        afterDiff.last_run_at === "2026-11-22T11:00:00.000Z",
      JSON.stringify(afterDiff),
    );
    const diffRun = rows(
      db,
      "SELECT errors, warnings, wiring FROM runs WHERE command = 'hook-stop'",
    )[0];
    check(
      "the diff run's own row says warnings were not measured",
      diffRun?.errors === 1 && diffRun.warnings === null && diffRun.wiring === null,
      JSON.stringify(diffRun),
    );

    // RED: a metrics-only run updates the metrics it measured, nothing else.
    writeRun(
      h,
      record({
        command: "metrics",
        metrics: { status: "measured", scope: "full", data: { runInActionCount: 7 } },
      }),
    );
    const afterMetrics = latest();
    check(
      "a metrics run sets its metric and keeps the others",
      afterMetrics.run_in_action === 7 && afterMetrics.sloc === 900 && afterMetrics.errors === 2,
      JSON.stringify(afterMetrics),
    );
    // A paths-scoped run is history only.
    writeRun(
      h,
      record({
        findings: { status: "measured", scope: "paths", data: { tiers: "all", list: [] } },
      }),
    );
    check("a paths-scoped verify does not refresh the latest counts", latest().errors === 2);
    check("history keeps every run", rows(db, "SELECT id FROM runs").length === 4);
    check(
      "metric_history holds full-scope metrics and counts only",
      rows(db, "SELECT metric FROM metric_history WHERE metric = 'runInActionCount'").length ===
        2 && rows(db, "SELECT metric FROM metric_history WHERE metric = 'errors'").length === 1,
    );
    h.close();

    const again = await openDatabase(db);
    again.close();
    check(
      "reopening keeps the schema version",
      rows(db, "PRAGMA user_version")[0]?.user_version === SCHEMA_VERSION,
    );

    // RED: a database from a newer guardrails is refused, never written.
    const newer = new DatabaseSync(db);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    let refused = false;
    try {
      (await openDatabase(db)).close();
    } catch (err) {
      refused = err instanceof RecordSchemaError;
    }
    check("a newer schema version is refused", refused);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- facet shape

async function shapeCases(): Promise<void> {
  const dir = tmp("shape");
  const db = join(dir, "g.sqlite");
  try {
    (await openDatabase(db)).close();
    for (const table of FACET_TABLES) {
      const list = rows(db, `PRAGMA table_list(${table})`)[0];
      const cols = rows(db, `PRAGMA table_xinfo(${table})`);
      const pk = cols.filter((c) => Number(c.pk) > 0);
      const types = new Set(cols.map((c) => String(c.type)));
      check(
        `${table} is STRICT, one id INTEGER PRIMARY KEY, INTEGER/REAL/TEXT only`,
        list?.strict === 1 &&
          pk.length === 1 &&
          pk[0]?.name === "id" &&
          pk[0]?.type === "INTEGER" &&
          [...types].every((t) => ["INTEGER", "REAL", "TEXT"].includes(t)),
        JSON.stringify({ list, pk, types: [...types] }),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- CLI

function repo(): string {
  const dir = tmp("repo");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://token@example.com/Acme/App.git");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return dir;
}

function cli(cwd: string, args: string[], env: Record<string, string>) {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function cliCases(): Promise<void> {
  const dir = repo();
  const state = tmp("state");
  const db = join(state, "g.sqlite");
  try {
    const off = cli(dir, ["verify"], { XDG_STATE_HOME: state });
    check(
      "unset GUARDRAILS_RECORD writes nothing",
      !existsSync(join(state, "agentvibes")),
      off.stderr,
    );

    const on = cli(dir, ["verify"], { GUARDRAILS_RECORD: db });
    const run = rows(
      db,
      "SELECT r.key, x.command, x.exit_code, x.branch, x.wiring FROM runs x JOIN repos r ON r.id = x.repo_id",
    )[0];
    check(
      "verify records one run under the credential-free key",
      on.status === 0 &&
        run?.key === "example.com/acme/app" &&
        run.command === "verify" &&
        run.exit_code === 0 &&
        run.branch === "main" &&
        run.wiring === "off" &&
        !/sqlite|Experimental/i.test(on.stderr),
      `${JSON.stringify(run)} stderr=${on.stderr}`,
    );

    cli(dir, ["hook-postedit"], { GUARDRAILS_RECORD: db });
    cli(dir, ["doctor"], { GUARDRAILS_RECORD: db });
    check("hook-postedit and doctor do not record", rows(db, "SELECT id FROM runs").length === 1);

    const stop = spawnSync("node", [CLI, "hook-stop"], {
      cwd: dir,
      input: '{"session_id":"record-test"}',
      encoding: "utf8",
      env: { ...process.env, GUARDRAILS_RECORD: db },
    });
    const stopRun = rows(
      db,
      "SELECT x.id, p.scope FROM runs x JOIN run_parts p ON p.run_id = x.id AND p.part = 'findings' WHERE x.command = 'hook-stop'",
    );
    check(
      "hook-stop records its diff findings",
      stop.status === 0 && stopRun.length === 1 && stopRun[0]?.scope === "diff",
      `${JSON.stringify(stopRun)} stderr=${stop.stderr}`,
    );

    const metrics = cli(dir, ["metrics"], { GUARDRAILS_RECORD: db });
    const latest = rows(db, "SELECT files, run_in_action FROM projects_latest")[0];
    check(
      "a real metrics run fills its projects_latest columns",
      metrics.status === 0 && latest?.files === 1 && latest.run_in_action === 0,
      `${JSON.stringify(latest)} stderr=${metrics.stderr}`,
    );

    // Several writers at once on a database that does not exist yet: each
    // creates, switches to WAL and migrates the same file. Every run lands.
    const fresh = join(state, "fresh", "g.sqlite");
    const N = 6;
    // Each child's stderr is kept: a failure that shows up only on a slow
    // runner must name its cause in the log.
    const results = await Promise.all(
      Array.from(
        { length: N },
        () =>
          new Promise<{ code: number; err: string }>((done) => {
            const child = spawn("node", [CLI, "verify"], {
              cwd: dir,
              env: { ...process.env, GUARDRAILS_RECORD: fresh },
              stdio: ["ignore", "ignore", "pipe"],
            });
            let err = "";
            child.stderr.on("data", (d: Buffer) => {
              err += d.toString();
            });
            child.on("close", (code) =>
              done({ code: err.includes("recording") ? -1 : (code ?? -2), err }),
            );
          }),
      ),
    );
    const codes = results.map((r) => r.code);
    check(
      `${N} concurrent runs all recorded`,
      codes.every((c) => c === 0) &&
        rows(fresh, "SELECT id FROM runs").length === N &&
        rows(fresh, "PRAGMA user_version")[0]?.user_version === SCHEMA_VERSION,
      `${JSON.stringify(codes)}\n  ${results
        .filter((r) => r.code !== 0)
        .map((r) => r.err.trim())
        .join("\n  ")}`,
    );

    // RED: an unwritable database keeps the verdict and says so on stderr.
    const blocker = join(state, "a-file");
    writeFileSync(blocker, "");
    const bad = cli(dir, ["verify"], { GUARDRAILS_RECORD: join(blocker, "g.sqlite") });
    check(
      "an unwritable database leaves the exit code and reports one line",
      bad.status === 0 && /recording verify to .* failed/.test(bad.stderr),
      `status ${bad.status} stderr=${bad.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  targetCases();
  repoKeyCases();
  await walSwitchCase();
  await writerCases();
  await shapeCases();
  await cliCases();
  if (failed > 0) {
    console.error(`\n${failed} recording check(s) failed`);
    return 1;
  }
  console.log("\nrecording passed");
  return 0;
}

process.exitCode = await main();
