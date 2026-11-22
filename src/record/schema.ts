// The recording database: the contract a dashboard or TUI reads. README
// "Recording" documents every table and column; change both together, and
// change the schema only through a new entry in MIGRATIONS.
//
// Two families of tables:
//
//   history  — `repos`, `runs` and the `run_*` tables. One row per run (and
//              per part of it), appended, never overwritten.
//   latest   — `projects_latest`, `findings_latest`, `overrides_latest`, plus
//              `metric_history`. Flat, one row per entity, scalar columns only,
//              rewritten for a repo at the end of every recorded run in the
//              same transaction. They exist so a faceted browser can push
//              filters down to SQLite: every one is STRICT, has a single
//              `id INTEGER PRIMARY KEY`, and only INTEGER / REAL / TEXT columns.
//
// Conventions: times are ISO-8601 UTC TEXT (`2026-11-22T10:00:00.000Z`);
// booleans are INTEGER 0/1; NULL means "not measured", never zero.

export const SCHEMA_VERSION = 1;

/**
 * projects_latest metric column → the metric name a run records. A command
 * that measures one of these emits it under exactly this name.
 */
export const METRIC_COLUMNS = {
  sloc: "sloc",
  files: "fileCount",
  avg_file_sloc: "avg_file_sloc",
  files_over_sloc_limit: "files_over_sloc_limit",
  run_in_action: "runInActionCount",
  worktrees: "git_worktrees",
  local_branches: "git_local_branches",
  build_ms: "build_ms",
} as const;

/** projects_latest wiring column → the wiring check id. */
export const WIRING_COLUMNS = {
  wiring_installed: "installed",
  wiring_sgconfig_canon: "sgconfig-canon",
  wiring_lint_script: "lint-script",
  wiring_ci: "ci",
  wiring_hook_postedit: "hook-postedit",
  wiring_hook_stop: "hook-stop",
  wiring_preset: "preset",
} as const;

/** Columns that hold a REAL; every other metric column is INTEGER. */
const REAL_METRIC_COLUMNS = new Set<string>(["avg_file_sloc"]);

const V1 = `
CREATE TABLE repos (
  id    INTEGER PRIMARY KEY,
  key   TEXT NOT NULL UNIQUE,
  host  TEXT NOT NULL,
  owner TEXT NOT NULL,
  name  TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id                       INTEGER PRIMARY KEY,
  repo_id                  INTEGER NOT NULL REFERENCES repos(id),
  at                       TEXT NOT NULL,
  command                  TEXT NOT NULL,
  root                     TEXT NOT NULL,
  sha                      TEXT,
  branch                   TEXT,
  duration_ms              INTEGER NOT NULL,
  exit_code                INTEGER NOT NULL,
  guardrails_version       TEXT NOT NULL,
  node_version             TEXT NOT NULL,
  ast_grep_version         TEXT,
  biome_version            TEXT,
  wiring                   TEXT,
  errors                   INTEGER,
  warnings                 INTEGER,
  overrides                INTEGER,
  overrides_without_reason INTEGER
) STRICT;
CREATE INDEX runs_repo_at ON runs(repo_id, at);

CREATE TABLE run_parts (
  id     INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  part   TEXT NOT NULL,
  status TEXT NOT NULL,
  scope  TEXT,
  reason TEXT
) STRICT;
CREATE INDEX run_parts_run ON run_parts(run_id);

CREATE TABLE run_wiring (
  id       INTEGER PRIMARY KEY,
  run_id   INTEGER NOT NULL REFERENCES runs(id),
  check_id TEXT NOT NULL,
  pass     INTEGER NOT NULL,
  detail   TEXT NOT NULL
) STRICT;
CREATE INDEX run_wiring_run ON run_wiring(run_id);

CREATE TABLE run_rule_counts (
  id     INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  rule   TEXT NOT NULL,
  tier   TEXT NOT NULL,
  source TEXT NOT NULL,
  count  INTEGER NOT NULL
) STRICT;
CREATE INDEX run_rule_counts_run ON run_rule_counts(run_id);

CREATE TABLE run_findings (
  id      INTEGER PRIMARY KEY,
  run_id  INTEGER NOT NULL REFERENCES runs(id),
  rule    TEXT NOT NULL,
  tier    TEXT NOT NULL,
  source  TEXT NOT NULL,
  file    TEXT NOT NULL,
  line    INTEGER NOT NULL,
  message TEXT NOT NULL
) STRICT;
CREATE INDEX run_findings_run ON run_findings(run_id);

CREATE TABLE run_overrides (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  kind       TEXT NOT NULL,
  rule       TEXT NOT NULL,
  "where"    TEXT NOT NULL,
  file       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  reason     TEXT,
  has_reason INTEGER NOT NULL
) STRICT;
CREATE INDEX run_overrides_run ON run_overrides(run_id);

CREATE TABLE metric_history (
  id     INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  repo   TEXT NOT NULL,
  at     TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  REAL NOT NULL
) STRICT;
CREATE INDEX metric_history_repo_metric ON metric_history(repo, metric, at);

CREATE TABLE projects_latest (
  id                       INTEGER PRIMARY KEY,
  key                      TEXT NOT NULL UNIQUE,
  host                     TEXT NOT NULL,
  owner                    TEXT NOT NULL,
  name                     TEXT NOT NULL,
  wiring                   TEXT,
${Object.keys(WIRING_COLUMNS)
  .map((c) => `  ${c.padEnd(24)} INTEGER,`)
  .join("\n")}
  errors                   INTEGER,
  warnings                 INTEGER,
  overrides                INTEGER,
  overrides_without_reason INTEGER,
${Object.keys(METRIC_COLUMNS)
  .map((c) => `  ${c.padEnd(24)} ${REAL_METRIC_COLUMNS.has(c) ? "REAL" : "INTEGER"},`)
  .join("\n")}
  last_run_at              TEXT NOT NULL,
  last_sha                 TEXT,
  last_branch              TEXT,
  last_command             TEXT NOT NULL,
  wiring_run_id            INTEGER,
  findings_run_id          INTEGER,
  overrides_run_id         INTEGER
) STRICT;

CREATE TABLE findings_latest (
  id      INTEGER PRIMARY KEY,
  repo    TEXT NOT NULL,
  rule    TEXT NOT NULL,
  tier    TEXT NOT NULL,
  file    TEXT NOT NULL,
  line    INTEGER NOT NULL,
  message TEXT NOT NULL
) STRICT;
CREATE INDEX findings_latest_repo ON findings_latest(repo);

CREATE TABLE overrides_latest (
  id         INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  rule       TEXT NOT NULL,
  "where"    TEXT NOT NULL,
  reason     TEXT,
  has_reason INTEGER NOT NULL,
  file       TEXT NOT NULL,
  line       INTEGER NOT NULL
) STRICT;
CREATE INDEX overrides_latest_repo ON overrides_latest(repo);
`;

/** MIGRATIONS[n] takes the database from user_version n to n + 1. */
export const MIGRATIONS: readonly string[] = [V1];

/** The latest tables a faceted browser reads, in README order. */
export const FACET_TABLES = [
  "projects_latest",
  "findings_latest",
  "overrides_latest",
  "metric_history",
] as const;

/** How many non-override findings one run stores in run_findings (errors first). */
export const TOP_FINDINGS_CAP = 200;
