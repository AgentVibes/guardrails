// `@agentvibes/guardrails/record`: what a dashboard or TUI needs to read the
// recording database — where it is, which schema version it speaks, and the
// row shape of each latest table. README "Recording" is the prose contract.

export { type FindingTool, toolOf } from "../findings.js";
export { LANGUAGE_IDS, type LanguageId } from "../lang/languages.js";
export {
  configuredDb,
  defaultDbPath,
  RecordConfigError,
  type RecordTarget,
  recordTarget,
  userConfigPath,
} from "./config.js";
export { parseRemote, repoIdentity } from "./repoKey.js";
export { LANGUAGES } from "./repoMetrics.js";
export type {
  FindingsData,
  LanguageFindings,
  Part,
  RepoIdentity,
  RunRecord,
  RunScope,
  ToolVersions,
} from "./runRecord.js";
export {
  FACET_TABLES,
  METRIC_COLUMNS,
  SCHEMA_VERSION,
  TOP_FINDINGS_CAP,
  WIRING_COLUMNS,
} from "./schema.js";

/** 0 or 1; NULL (null) where the part was never measured. */
type Flag = 0 | 1 | null;

export interface ProjectLatestRow {
  id: number;
  key: string;
  host: string;
  owner: string;
  name: string;
  wiring: "off" | "partial" | "on" | null;
  wiring_installed: Flag;
  wiring_sgconfig_canon: Flag;
  wiring_lint_script: Flag;
  wiring_ci: Flag;
  wiring_hook_postedit: Flag;
  wiring_hook_stop: Flag;
  wiring_preset: Flag;
  wiring_rust_clippy_strict: Flag;
  wiring_rust_lints_inherited: Flag;
  wiring_rust_toolchain: Flag;
  wiring_rust_ci: Flag;
  /** `typescript,rust`: the languages the last run checked (schema v2; NULL before). */
  languages: string | null;
  /** One `<language>: <reason>` line per language whose findings could not be measured; NULL when all were. */
  findings_unavailable: string | null;
  errors: number | null;
  warnings: number | null;
  overrides: number | null;
  overrides_without_reason: number | null;
  sloc: number | null;
  files: number | null;
  avg_file_sloc: number | null;
  files_over_sloc_limit: number | null;
  run_in_action: number | null;
  worktrees: number | null;
  local_branches: number | null;
  build_ms: number | null;
  last_run_at: string;
  last_sha: string | null;
  last_branch: string | null;
  last_command: string;
  wiring_run_id: number | null;
  findings_run_id: number | null;
  overrides_run_id: number | null;
}

export interface FindingLatestRow {
  id: number;
  repo: string;
  rule: string;
  tier: "error" | "warning" | "info" | "hint";
  file: string;
  line: number;
  message: string;
  /** The tool that produced the finding (schema v2). */
  tool: "ast-grep" | "guardrails" | "clippy" | "rustc" | "rustfmt";
}

export interface OverrideLatestRow {
  id: number;
  repo: string;
  kind:
    | "ast-grep-ignore"
    | "biome-ignore"
    | "verify-scope"
    | "biome-rule"
    | "repo-rule-shadow"
    | "metrics-limit"
    | "rust-allow"
    | "cargo-lint";
  rule: string;
  where: string;
  reason: string | null;
  has_reason: 0 | 1;
  file: string;
  line: number;
}

export interface MetricHistoryRow {
  id: number;
  run_id: number;
  repo: string;
  at: string;
  metric: string;
  value: number;
}
