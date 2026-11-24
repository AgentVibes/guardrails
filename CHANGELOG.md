# Changelog

## Unreleased

- **`verify` and `snapshot` of this package's own checkout skip
  `rules/__fixtures__/`.** Those files are the examples each rule's test runs
  on, and `bad.ts` violates on purpose. `verify-diff` already skipped them;
  the full scan counted them, so a snapshot of this repo recorded 162 errors
  that were all fixtures. The checkout is recognised by its package name, as
  `doctor` does. In any other repo, `rules/__fixtures__/` is scanned as before.

- **A gated metric missing from an older `.guardrails/metrics.json` no
  longer fails `metrics --check`.** It was read as 0, so a release that adds
  a gated metric would turn every repo with an older baseline red. Now
  `--check` prints a notice that the metric is not yet gated (and lists it in
  `notYetGated` in `--json`), and `--update-baseline` adopts its current
  value (`adopted`). A present gated value that is not a number is now an
  unrecognised baseline shape. The per-file length baseline
  (`.guardrails/file-sloc.json`) is keyed by file, not by metric, so a release
  does not add keys to it; it is unchanged.

## 0.4.2 (2026-11-24)

- **A checkout without `node_modules` is scanned with the running
  package's rules.** A wired repo's `sgconfig.yml` lists
  `node_modules/@agentvibes/guardrails/rules`. In a checkout where
  dependencies are not installed (a fresh worktree), that dir is missing and
  ast-grep exited 6, so the findings were `unavailable`. Now `verify`,
  `verify-diff`, `snapshot` and the hooks scan with a temporary copy of the
  config that points that dir at the rules of the guardrails install that is
  running. The repo's file is not changed. `snapshot` prints a note (and a
  `notes` array in `--json`) that names the dir and the running version;
  `verify` and `verify-diff` print the same note on stderr. The version is
  `runs.guardrails_version`, as for every run. When another listed dir is
  missing too (not under `node_modules/@agentvibes/guardrails/`), nothing is
  replaced and the scan fails as before, naming the repo's `sgconfig.yml`.
- **`snapshot` records the languages when the findings are unavailable.**
  `runs.languages` and `projects_latest.languages` were NULL when the
  TypeScript findings could not be measured. `verify` now records them too
  when it stops before the TypeScript scan (preset drift, a config ast-grep
  cannot load, a bad `[severity]` or screen scope table).
- **A TypeScript findings failure is recorded per language**, like a Rust
  one: a `run_parts` row with `language = 'typescript'`, status
  `unavailable` and the reason. `projects_latest.findings_unavailable` now
  shows it (`typescript: <reason>`) for a run over the whole checkout; the
  error and warning counts keep the last measured run. The whole-run row
  (`language IS NULL`) is unchanged: still `unavailable` with the TypeScript
  reason.

## 0.4.1 (2026-11-24)

- **The agent hooks do nothing in a checkout without an install.** The hook
  command `guardrails init` writes now checks that the package is installed
  (`node_modules/.bin/guardrails` under `$CLAUDE_PROJECT_DIR`) and exits 0
  without output when it is not, so a fresh worktree no longer shows the
  agent a "command not found" error after every edit. README "Agent hooks".
- `init` rewrites a hook in the old form (`pnpm exec guardrails hook-…` and
  the yarn and npx variants) to the new one, in any repo, and keeps the rest
  of `.claude/settings.json`. A wrapped command is left as it is.
- `doctor` passes both forms. For the old form it prints an `upgrade:` line
  under the `hook-postedit` or `hook-stop` check, and `doctor --json` has a
  `hint` field on that check.

## 0.4.0 (2026-11-22)

- Languages. guardrails runs one adapter per language: `typescript`
  (`package.json` or `tsconfig.json`) and, new, `rust` (a `Cargo.toml`).
  Both found is a mixed repo; neither is `typescript`, as before. Set the
  list with `[languages] enabled = [...]` in `.agentvibes/project.toml`.
  README "Languages".
- Rust adapter (README "Rust"):
  - `verify`, `verify-diff`, `hook-stop` and `snapshot` run `cargo clippy
    --message-format=json --all-targets` and `cargo fmt --check`;
    `verify-diff` and `hook-stop` fail only on findings on added lines.
  - `hook-postedit` on a `.rs` file runs clippy for the package that owns it,
    with a time limit (`GUARDRAILS_CLIPPY_TIMEOUT_S`).
  - `doctor` has four wiring checks: `rust.clippy-strict` (the lint table
    against the shipped canon, `configs/rust-lints.toml`),
    `rust.lints-inherited`, `rust.toolchain` and `rust.ci`.
  - The override inventory lists every `#[allow]`, `#![allow]` and
    `#[expect]` (`rust-allow`) and every canon lint lowered in `Cargo.toml`
    (`cargo-lint`).
  - `init` writes the canon lint table, `[lints] workspace = true`,
    `rust-toolchain.toml`, `clippy.toml` and the Claude Code hooks.
- **A check that could not run is exit 2.** `verify` and `verify-diff` exit 2
  (when there is no error finding) if a check could not run: a Rust build
  that does not compile, or cargo missing or timing out. Before, a TypeScript
  repo had no such case.
- **Behaviour change for TypeScript repos that contain a `Cargo.toml`** (a
  Tauri app, a native module): they are now detected as mixed, so `verify`,
  `verify-diff` and `hook-stop` also run clippy and rustfmt, `doctor` reports
  the Rust tools and wiring checks, and a machine without cargo gets exit 2
  from `verify`. To keep the old behaviour, set
  `[languages] enabled = ["typescript"]`.
- Recording schema v2. The migration only adds columns and keeps every v1
  row (tested on a copy of a real database: every table's row count is the
  same before and after):
  - `runs.languages`;
  - `run_parts.language`. A run now has its usual findings row with
    `language` NULL, plus one findings row per language checked, so readers
    that select one findings row per run add `AND language IS NULL`;
  - `run_wiring.adapter`;
  - `tool` in `run_rule_counts`, `run_findings` and `findings_latest`;
  - in `projects_latest`: `languages`, `findings_unavailable` and the
    `wiring_rust_*` columns.

  **guardrails 0.3 refuses a v2 database** ("the database is schema v2; this
  guardrails writes v1"). A database shared by several writers and readers
  must have all of them upgraded together.

## 0.3.1 (2026-11-22)

- doctor, snapshot and verify recognise a checkout of this package by its
  package.json name (`@agentvibes/guardrails`), not only when it is the
  install that is running. Before, an installed copy run against a separate
  checkout of this repo reported `installed`, `sgconfig-canon` and `preset` as
  missing and counted every canon rule in `rules/` as a repo rule shadowing
  the canon (61 extra overrides without a reason).
- In this package's own source, the overrides inventory and `verify-diff`
  skip `rules/__fixtures__/`: those files are rule-test inputs that violate,
  or suppress, on purpose. Consumer repos are scanned as before (tested both
  ways in `test:overrides`).
- This repo is wired to itself: `pnpm lint` runs `guardrails verify-diff` and
  `guardrails doctor` through a `guardrails` script (`node dist/cli.js`, since
  pnpm does not link a package's own bin), and `.claude/settings.json` runs
  the post-edit and Stop hooks the same way.

## 0.3.0 (2026-11-22)

- Per-file length ratchet: files in test directories (`tests/`, `test/`,
  `e2e/`, `spec/`, `__tests__/`, `__e2e__/`, `__mocks__/`) are test code and no
  longer gated, and `files_over_sloc_limit` counts the same files as the gate.
  An existing baseline that lists such files is not checked for them, and the
  next `--update-baseline` drops their entries.
- Comments, rule notes and docs no longer name private issue ids, private
  consumer repositories or internal notes; they describe the case in plain
  words. `.guardrails/leaks.txt` makes `pnpm leaks` fail on an issue id, so
  ids cannot return.
- Recording: the first runs that race on a new database no longer lose a
  write. Switching the file to WAL opens a read transaction and upgrades it
  to a write, and SQLite does not apply busy_timeout to that upgrade, so a
  losing run got "database is locked" at once. The switch now retries for up
  to 5 s.
- `time`: `--name` is read only for `time`, so `guardrails deploy --name x`
  passes `--name x` to the deploy plugin again. `guardrails --json time -- CMD`
  also leaves the flags after `--` to CMD.
- `guardrails time [--name N] -- CMD` runs a command, passes its output and
  exit code through, and, while recording, stores its wall-clock time as
  metric `build_ms` (or N; `projects_latest.build_ms`). A run that does not
  exit 0 is recorded without a time. 127 when the command cannot start.
- `guardrails snapshot [path]` records one checkout into the recording
  database, whether or not it uses guardrails, and writes nothing into it.
  Each part is measured on its own; one that fails is recorded `unavailable`
  with its reason, so a repo without guardrails is wiring `off` with its
  metrics. Exit 2 only when the path is not a directory or the record fails.
- Recorded metrics (from `metrics` while recording, and `snapshot`): `sloc`,
  `avg_file_sloc`, `files_over_sloc_limit`, `loc` and `loc.<language>`,
  `git_worktrees`, `git_local_branches`; the matching `projects_latest`
  columns are filled.
- The overrides inventory skips gitignored files: a suppression in generated
  code is not the project's override.
- Recording: with `GUARDRAILS_RECORD=1` (or a database path), `verify`,
  `verify-diff`, `metrics` and `hook-stop` append what they measured to a
  SQLite database: one `runs` row per run with its sha, branch, command,
  duration, exit code and tool versions; findings counted by rule and tier
  plus the top 200; overrides with their reasons; wiring checks; metrics.
  Flat `projects_latest` / `findings_latest` / `overrides_latest` /
  `metric_history` tables (STRICT, one integer `id`) are refreshed for
  faceted browsers, so "wired but overridden" is one filter. Only a
  full-checkout measurement refreshes them. Database: `[record] db` in
  `$XDG_CONFIG_HOME/agentvibes/guardrails.toml`, else
  `$XDG_STATE_HOME/agentvibes/guardrails.sqlite`. Schema v1 is documented in
  README "Recording"; readers import `@agentvibes/guardrails/record`.
  Recording never changes an exit code.
- `engines.node` is now `>=22.13.0`, the first 22.x with `node:sqlite`.
  It is loaded only when a run records.
- `doctor` reports wiring: seven checks (installed, sgconfig lists the canon
  rule dir, lint script runs guardrails, CI runs it, the post-edit and stop
  hooks are registered, no preset drift), each with its evidence, and a state
  `off` / `partial` / `on`. `on` needs every check AND zero overrides.
  `detectWiring(root)` is exported as `@agentvibes/guardrails/wiring`. The
  exit code is unchanged. The text output lists at most 20 override findings;
  `--json` lists all.
- Overrides inventory: `verify` and `doctor` list every deviation from the
  canon (inline `ast-grep-ignore` / `biome-ignore`, `[verify]` scopes,
  biome rule overrides, repo rules reusing a canon id, a raised
  `max_file_sloc`) with its reason, under `overrides` in `--json`. Every
  override is a warning, `canon-overridden`, reason or not; a reason-less one
  is also `override-without-reason`; a declaration that
  matches nothing is `override-declared-unused`. Configured overrides take
  their reason from `[[override]]` in `.agentvibes/project.toml`.
  `collectOverrides(root)` is exported as `@agentvibes/guardrails/overrides`.
- Biome preset: a rule override beyond `noConsole` / test-scoped
  `noEmptyBlockStatements` is no longer drift when declared in
  `[[override]]` with the same rule, the entry's exact `includes` and a
  reason. Undeclared ones still gate. An unreadable `[[override]]` table is
  drift (`override-config`).
- New dependencies: `smol-toml` (parses `[[override]]`), `zod` (validates it).
- CLI: `<command> --help` prints usage; an unknown option is a usage error
  (exit 2); a path target that does not exist is exit 2. Before, an unknown
  flag fell through to ast-grep as a scan target: `guardrails metrics --help`
  made ast-grep print its own help with exit 0, and the JSON parse crashed
  with "ast-grep produced unparsable JSON (exit 0)". Targets now follow `--`
  in the ast-grep call, and that error shows the start of stdout.
