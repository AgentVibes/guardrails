import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { match } from "ts-pattern";
import type { Finding } from "../findings.js";
import type { Override } from "../overrides.js";
import type { FindingsData, Part, RunRecord } from "./runRecord.js";
import {
  METRIC_COLUMNS,
  MIGRATIONS,
  SCHEMA_VERSION,
  TOP_FINDINGS_CAP,
  WIRING_COLUMNS,
} from "./schema.js";

// Stores a RunRecord. One transaction per run: the history rows and the
// refresh of the latest tables commit together or not at all, so a reader
// never sees a run without its projects_latest row or the reverse.
//
// Concurrency: WAL lets readers (a dashboard) run while a run writes; two
// writers (two repos' hooks at once) serialise on BEGIN IMMEDIATE, each
// waiting up to BUSY_TIMEOUT_MS for the other.

export const BUSY_TIMEOUT_MS = 5000;

export class RecordSchemaError extends Error {}

/** Opens node:sqlite lazily, so commands that never record never load it. */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  // Node 22.13–23 print an ExperimentalWarning on the first import of
  // node:sqlite. It is noise on a hook's stderr; every other warning passes.
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    (original as (w: string | Error, ...r: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  if (row === undefined) throw new RecordSchemaError("PRAGMA user_version returned no row");
  return row.user_version;
}

/** Brings the database to SCHEMA_VERSION. A database from a newer guardrails is refused. */
export function migrate(db: DatabaseSync): void {
  if (userVersion(db) === SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read again under the write lock: another process may have migrated
    // between the first read and BEGIN IMMEDIATE.
    const from = userVersion(db);
    if (from > SCHEMA_VERSION) {
      throw new RecordSchemaError(
        `the database is schema v${from}; this guardrails writes v${SCHEMA_VERSION} — upgrade guardrails`,
      );
    }
    for (let v = from; v < SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v];
      if (step === undefined) throw new RecordSchemaError(`no migration from v${v}`);
      db.exec(step);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export async function openDatabase(path: string): Promise<DatabaseSync> {
  mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** undefined is "not measured", stored as NULL; SQLite has no booleans. */
function v(value: string | number | boolean | undefined): SQLInputValue {
  // ast-grep-ignore: silent-default-return -- undefined is the documented "not measured" value and NULL is its column form, not a masked failure
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** Override findings restate run_overrides; counts and lists keep them apart. */
function codeFindings(list: Finding[]): Finding[] {
  return list.filter((f) => f.source !== "override");
}

interface Counts {
  errors: number | undefined;
  warnings: number | undefined;
}

function findingCounts(part: Part<FindingsData>): Counts {
  return match(part)
    .with({ status: "measured" }, (p) => {
      const code = codeFindings(p.data.list);
      return {
        errors: code.filter((f) => f.severity === "error").length,
        warnings: match(p.data.tiers)
          .with("all", () => code.filter((f) => f.severity === "warning").length)
          .with("error-only", () => undefined)
          .exhaustive(),
      };
    })
    .with({ status: "unavailable" }, { status: "skipped" }, () => ({
      errors: undefined,
      warnings: undefined,
    }))
    .exhaustive();
}

function overrideCounts(part: Part<Override[]>): { total?: number; withoutReason?: number } {
  return match(part)
    .with({ status: "measured" }, (p) => ({
      total: p.data.length,
      withoutReason: p.data.filter((o) => o.reason.status === "missing").length,
    }))
    .with({ status: "unavailable" }, { status: "skipped" }, () => ({}))
    .exhaustive();
}

function reasonText(o: Override): string | undefined {
  return match(o.reason)
    .with({ status: "given" }, (r) => r.text)
    .with({ status: "missing" }, () => undefined)
    .exhaustive();
}

/** The data of a part measured over the whole repo; undefined otherwise. */
function fullData<T>(part: Part<T>): T | undefined {
  return match(part)
    .with({ status: "measured", scope: "full" }, (p) => p.data)
    .with(
      { status: "measured", scope: "diff" },
      { status: "measured", scope: "paths" },
      () => undefined,
    )
    .with({ status: "unavailable" }, { status: "skipped" }, () => undefined)
    .exhaustive();
}

function measuredData<T>(part: Part<T>): T | undefined {
  return match(part)
    .with({ status: "measured" }, (p) => p.data)
    .with({ status: "unavailable" }, { status: "skipped" }, () => undefined)
    .exhaustive();
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, hint: 3 } as const;

function insertHistory(db: DatabaseSync, r: RunRecord, repoId: number): number {
  const counts = findingCounts(r.findings);
  const ov = overrideCounts(r.overrides);
  const wiring = measuredData(r.wiring);
  const run = db
    .prepare(
      `INSERT INTO runs (repo_id, at, command, root, sha, branch, duration_ms, exit_code,
         guardrails_version, node_version, ast_grep_version, biome_version,
         wiring, errors, warnings, overrides, overrides_without_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repoId,
      r.at,
      r.command,
      r.root,
      v(r.sha),
      v(r.branch),
      Math.round(r.durationMs),
      r.exitCode,
      r.tools.guardrails,
      r.tools.node,
      v(r.tools.astGrep),
      v(r.tools.biome),
      v(wiring?.state),
      v(counts.errors),
      v(counts.warnings),
      v(ov.total),
      v(ov.withoutReason),
    );
  const runId = Number(run.lastInsertRowid);

  const partRow = db.prepare(
    "INSERT INTO run_parts (run_id, part, status, scope, reason) VALUES (?, ?, ?, ?, ?)",
  );
  const parts: [string, Part<unknown>][] = [
    ["findings", r.findings],
    ["overrides", r.overrides],
    ["wiring", r.wiring],
    ["metrics", r.metrics],
  ];
  for (const [name, part] of parts) {
    match(part)
      .with({ status: "measured" }, (p) => partRow.run(runId, name, p.status, p.scope, null))
      .with({ status: "unavailable" }, (p) => partRow.run(runId, name, p.status, null, p.reason))
      .with({ status: "skipped" }, (p) => partRow.run(runId, name, p.status, null, null))
      .exhaustive();
  }

  if (wiring !== undefined) {
    const row = db.prepare(
      "INSERT INTO run_wiring (run_id, check_id, pass, detail) VALUES (?, ?, ?, ?)",
    );
    for (const c of wiring.checks) row.run(runId, c.id, v(c.status === "pass"), c.detail);
  }

  const findings = measuredData(r.findings);
  if (findings !== undefined) {
    const tally = new Map<string, { rule: string; tier: string; source: string; n: number }>();
    for (const f of findings.list) {
      const k = `${f.rule}\0${f.severity}\0${f.source}`;
      const t = tally.get(k) ?? { rule: f.rule, tier: f.severity, source: f.source, n: 0 };
      t.n += 1;
      tally.set(k, t);
    }
    const countRow = db.prepare(
      "INSERT INTO run_rule_counts (run_id, rule, tier, source, count) VALUES (?, ?, ?, ?, ?)",
    );
    for (const t of tally.values()) countRow.run(runId, t.rule, t.tier, t.source, t.n);
    const top = codeFindings(findings.list)
      .map((f, i) => ({ f, i }))
      .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
      .slice(0, TOP_FINDINGS_CAP);
    const findingRow = db.prepare(
      `INSERT INTO run_findings (run_id, rule, tier, source, file, line, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { f } of top) {
      findingRow.run(runId, f.rule, f.severity, f.source, f.file, f.line, f.message);
    }
  }

  const overrides = measuredData(r.overrides);
  if (overrides !== undefined) {
    const row = db.prepare(
      `INSERT INTO run_overrides (run_id, kind, rule, "where", file, line, reason, has_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of overrides) {
      const reason = reasonText(o);
      row.run(runId, o.kind, o.rule, o.where, o.file, o.line, v(reason), v(reason !== undefined));
    }
  }
  return runId;
}

/** Metric name → value for metric_history: the run's metrics plus its full-scope counts. */
function historyMetrics(r: RunRecord): Map<string, number> {
  const out = new Map<string, number>(Object.entries(fullData(r.metrics) ?? {}));
  const findings = fullData(r.findings);
  if (findings !== undefined) {
    const c = findingCounts(r.findings);
    if (c.errors !== undefined) out.set("errors", c.errors);
    if (c.warnings !== undefined && findings.tiers === "all") out.set("warnings", c.warnings);
  }
  if (fullData(r.overrides) !== undefined) {
    const o = overrideCounts(r.overrides);
    if (o.total !== undefined) out.set("overrides", o.total);
    if (o.withoutReason !== undefined) out.set("overrides_without_reason", o.withoutReason);
  }
  return out;
}

function refreshLatest(db: DatabaseSync, r: RunRecord, runId: number): void {
  // The row exists after this; every later statement only sets what this run measured.
  db.prepare(
    `INSERT INTO projects_latest (key, host, owner, name, last_run_at, last_sha, last_branch, last_command)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET host = excluded.host, owner = excluded.owner,
       name = excluded.name, last_run_at = excluded.last_run_at, last_sha = excluded.last_sha,
       last_branch = excluded.last_branch, last_command = excluded.last_command`,
  ).run(r.repo.key, r.repo.host, r.repo.owner, r.repo.name, r.at, v(r.sha), v(r.branch), r.command);

  const set = (columns: Record<string, SQLInputValue>): void => {
    const names = Object.keys(columns);
    if (names.length === 0) return;
    db.prepare(
      `UPDATE projects_latest SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE key = ?`,
    ).run(...Object.values(columns), r.repo.key);
  };

  const wiring = fullData(r.wiring);
  if (wiring !== undefined) {
    const byId = new Map(wiring.checks.map((c) => [c.id, c.status === "pass"]));
    set({
      wiring: wiring.state,
      wiring_run_id: runId,
      ...Object.fromEntries(
        Object.entries(WIRING_COLUMNS).map(([col, id]) => [col, v(byId.get(id))]),
      ),
    });
  }

  const findings = fullData(r.findings);
  if (findings !== undefined && findings.tiers === "all") {
    const c = findingCounts(r.findings);
    set({ errors: v(c.errors), warnings: v(c.warnings), findings_run_id: runId });
    db.prepare("DELETE FROM findings_latest WHERE repo = ?").run(r.repo.key);
    const row = db.prepare(
      "INSERT INTO findings_latest (repo, rule, tier, file, line, message) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const f of codeFindings(findings.list)) {
      row.run(r.repo.key, f.rule, f.severity, f.file, f.line, f.message);
    }
  }

  const overrides = fullData(r.overrides);
  if (overrides !== undefined) {
    const o = overrideCounts(r.overrides);
    set({
      overrides: v(o.total),
      overrides_without_reason: v(o.withoutReason),
      overrides_run_id: runId,
    });
    db.prepare("DELETE FROM overrides_latest WHERE repo = ?").run(r.repo.key);
    const row = db.prepare(
      `INSERT INTO overrides_latest (repo, kind, rule, "where", reason, has_reason, file, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ov of overrides) {
      const reason = reasonText(ov);
      row.run(
        r.repo.key,
        ov.kind,
        ov.rule,
        ov.where,
        v(reason),
        v(reason !== undefined),
        ov.file,
        ov.line,
      );
    }
  }

  const metrics = fullData(r.metrics);
  if (metrics !== undefined) {
    set(
      Object.fromEntries(
        Object.entries(METRIC_COLUMNS)
          .filter(([, name]) => metrics[name] !== undefined)
          .map(([col, name]) => [col, v(metrics[name])]),
      ),
    );
  }

  const history = db.prepare(
    "INSERT INTO metric_history (run_id, repo, at, metric, value) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [name, value] of historyMetrics(r)) history.run(runId, r.repo.key, r.at, name, value);
}

/** Appends the run and refreshes the repo's latest rows in one transaction; returns the run id. */
export function writeRun(db: DatabaseSync, r: RunRecord): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    const repo = db
      .prepare(
        `INSERT INTO repos (key, host, owner, name) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET host = excluded.host, owner = excluded.owner, name = excluded.name
         RETURNING id`,
      )
      .get(r.repo.key, r.repo.host, r.repo.owner, r.repo.name) as { id: number } | undefined;
    if (repo === undefined) throw new RecordSchemaError(`no repos row for ${r.repo.key}`);
    const runId = insertHistory(db, r, repo.id);
    refreshLatest(db, r, runId);
    db.exec("COMMIT");
    return runId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
