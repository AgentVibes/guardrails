# Changelog

## Unreleased

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
