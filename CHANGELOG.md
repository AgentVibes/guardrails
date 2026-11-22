# Changelog

## Unreleased

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
