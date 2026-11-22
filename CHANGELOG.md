# Changelog

## Unreleased

- `guardrails metrics`: new gated metric `filesOverLineLimit`, the number of
  non-test source files longer than `[metrics] max_file_lines` raw lines
  (default 500). The report lists the long files. New observed values:
  `avgFileLines`, `maxFileLines`, `maxFileLinesLimit`.
- `guardrails metrics --check`: a gated metric missing from an older baseline
  is reported as not yet gated instead of being compared against 0;
  `--update-baseline` adopts it.
- CLI: `<command> --help` prints usage; an unknown option is a usage error
  (exit 2); a path target that does not exist is exit 2. Before, an unknown
  flag fell through to ast-grep as a target: `guardrails metrics --help` made
  ast-grep print its own help with exit 0 and crashed the JSON parse
  ("ast-grep produced unparsable JSON (exit 0)"). Targets now follow `--`.
- New dependencies: `smol-toml` (typed reader for the new
  `.agentvibes/project.toml` tables) and `zod`.
