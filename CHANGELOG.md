# Changelog

## Unreleased

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
