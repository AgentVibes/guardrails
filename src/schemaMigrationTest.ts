import "./testIsolation.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { match } from "ts-pattern";
import { z } from "zod";
import { MIGRATIONS, SCHEMA_VERSION } from "./record/schema.js";
import { migrate, RecordSchemaError } from "./record/writer.js";

// Schema v1 → v2 on a database built exactly as 0.3.x left it: the v1 SQL,
// user_version 1, three rows in every table. The migration must keep every
// row, add the v2 columns and backfill them (tool from source, wiring
// adapter from the check id, findings_latest tool from the rule name).

let failed = 0;
function expect(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}\n  ${JSON.stringify(detail, null, 2)}`);
}

const Column = z.object({ name: z.string(), type: z.string(), pk: z.number() }).loose();
type Column = z.infer<typeof Column>;

function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columns(db: DatabaseSync, table: string): Column[] {
  return z.array(Column).parse(db.prepare(`PRAGMA table_info(${table})`).all());
}

/** Values the backfills read; every other column gets a generic value. */
const PINNED: Record<string, Record<string, string[]>> = {
  run_findings: { source: ["ast-grep", "guardrails", "override"] },
  run_rule_counts: { source: ["ast-grep", "guardrails", "ast-grep"] },
  run_wiring: { check_id: ["hook-stop", "ci", "hook-postedit"] },
  findings_latest: { rule: ["file-sloc", "no-explicit-any", "ts-suppression"] },
};

function fill(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables(db)) {
    const cols = columns(db, table).filter((c) => c.pk === 0);
    const insert = db.prepare(
      `INSERT INTO ${table} (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    );
    for (let i = 0; i < 3; i++) {
      insert.run(
        ...cols.map((c) => {
          const pinned = PINNED[table]?.[c.name]?.[i];
          if (pinned !== undefined) return pinned;
          return match(c.type)
            .with("INTEGER", () => (c.name.endsWith("_id") ? 1 : i))
            .with("REAL", () => i + 0.5)
            .otherwise(() => `${c.name}-${i}`);
        }),
      );
    }
    counts[table] = 3;
  }
  return counts;
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function column(db: DatabaseSync, table: string, col: string): string[] {
  return (db.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY id`).all() as { v: unknown }[]).map(
    (r) => String(r.v),
  );
}

function v1Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(MIGRATIONS[0] ?? "");
  db.exec("PRAGMA user_version = 1");
  return db;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-migration-"));
  try {
    const db = v1Database(join(dir, "v1.sqlite"));
    const before = fill(db);
    const v1Columns = Object.fromEntries(
      tables(db).map((t) => [t, columns(db, t).map((c) => c.name)]),
    );
    migrate(db);
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    expect(
      "user_version is the current schema",
      version === SCHEMA_VERSION && version === 2,
      version,
    );
    const after = Object.fromEntries(tables(db).map((t) => [t, count(db, t)]));
    expect(
      "every v1 row is kept, no table lost",
      JSON.stringify(after) === JSON.stringify(before),
      {
        before,
        after,
      },
    );
    const kept = Object.entries(v1Columns).every(([t, cols]) => {
      const now = columns(db, t).map((c) => c.name);
      return cols.every((c) => now.includes(c));
    });
    expect("every v1 column is still there", kept, v1Columns);
    const added = (t: string) =>
      columns(db, t)
        .map((c) => c.name)
        .filter((c) => !v1Columns[t]?.includes(c));
    const v2 = {
      runs: added("runs"),
      run_parts: added("run_parts"),
      run_wiring: added("run_wiring"),
      run_rule_counts: added("run_rule_counts"),
      run_findings: added("run_findings"),
      findings_latest: added("findings_latest"),
      projects_latest: added("projects_latest"),
      run_overrides: added("run_overrides"),
      overrides_latest: added("overrides_latest"),
      metric_history: added("metric_history"),
      repos: added("repos"),
    };
    expect(
      "v2 adds exactly the documented columns",
      JSON.stringify(v2) ===
        JSON.stringify({
          runs: ["languages"],
          run_parts: ["language"],
          run_wiring: ["adapter"],
          run_rule_counts: ["tool"],
          run_findings: ["tool"],
          findings_latest: ["tool"],
          projects_latest: [
            "languages",
            "findings_unavailable",
            "wiring_rust_clippy_strict",
            "wiring_rust_lints_inherited",
            "wiring_rust_toolchain",
            "wiring_rust_ci",
          ],
          run_overrides: [],
          overrides_latest: [],
          metric_history: [],
          repos: [],
        }),
      v2,
    );
    expect(
      "run_findings.tool backfilled from source",
      column(db, "run_findings", "tool").join() === "ast-grep,guardrails,guardrails",
      column(db, "run_findings", "tool"),
    );
    expect(
      "run_rule_counts.tool backfilled from source",
      column(db, "run_rule_counts", "tool").join() === "ast-grep,guardrails,ast-grep",
      column(db, "run_rule_counts", "tool"),
    );
    expect(
      "run_wiring.adapter: hooks are shared, the rest typescript",
      column(db, "run_wiring", "adapter").join() === "shared,typescript,shared",
      column(db, "run_wiring", "adapter"),
    );
    expect(
      "findings_latest.tool: guardrails' own rules by name, the rest ast-grep",
      column(db, "findings_latest", "tool").join() === "guardrails,ast-grep,guardrails",
      column(db, "findings_latest", "tool"),
    );
    expect(
      "v1 runs have no languages recorded (NULL, not a guess)",
      column(db, "runs", "languages").every((v) => v === "null"),
      column(db, "runs", "languages"),
    );
    migrate(db);
    expect("migrating a v2 database again changes nothing", count(db, "runs") === 3, null);
    db.close();

    const future = new DatabaseSync(join(dir, "v9.sqlite"));
    future.exec("PRAGMA user_version = 9");
    let thrown: unknown;
    try {
      migrate(future);
    } catch (err) {
      thrown = err;
    }
    expect(
      "a newer database is refused, not rewritten",
      thrown instanceof RecordSchemaError && String(thrown).includes("v9"),
      String(thrown),
    );
    future.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`\n${failed} schema migration check(s) failed`);
    return 1;
  }
  console.log("\nSchema migration checks passed");
  return 0;
}

process.exit(main());
