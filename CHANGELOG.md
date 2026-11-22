# Changelog

## Unreleased

- CLI: `<command> --help` prints usage; an unknown option is a usage error
  (exit 2); a path target that does not exist is exit 2. Before, an unknown
  flag fell through to ast-grep as a scan target: `guardrails metrics --help`
  made ast-grep print its own help with exit 0, and the JSON parse crashed
  with "ast-grep produced unparsable JSON (exit 0)". Targets now follow `--`
  in the ast-grep call, and that error shows the start of stdout.
