import type { Finding, Severity } from "../findings.js";
import type { LanguageId } from "../lang/languages.js";
import type { Override } from "../overrides.js";
import type { WiringReport } from "../wiring.js";

// What one guardrails run observed, as plain data. Commands build it; the
// writer (writer.ts) stores it. Nothing here touches the database, so a
// command can be tested on the record it builds without SQLite.
//
// Every part is optional BY DESIGN of the run, not by accident: `metrics`
// measures no findings, `hook-stop` measures findings on a diff only. A part
// is either measured (with its data) or not, and a part that was attempted and
// failed is `unavailable` with the reason, so the dashboard can tell "not
// measured" from "measured zero".

/** How much of the repo a run looked at. Only `full` runs refresh the latest tables. */
export type RunScope = "full" | "diff" | "paths";

export type Part<T> =
  | { status: "measured"; scope: RunScope; data: T }
  | { status: "unavailable"; reason: string }
  | { status: "skipped" };

export const SKIPPED = { status: "skipped" } as const;

export interface RepoIdentity {
  /** `host/owner/name`, lowercase, no `.git`; `local/<dir>` when there is no origin. */
  key: string;
  host: string;
  /** All path segments but the last (GitLab subgroups stay joined with `/`). */
  owner: string;
  name: string;
}

/**
 * The findings a run measured. `error-only`: the run looked for error-tier
 * findings only (the diff ratchet), so it says nothing about warnings.
 */
export interface FindingsData {
  tiers: "all" | "error-only";
  list: Finding[];
}

export interface ToolVersions {
  guardrails: string;
  node: string;
  astGrep: string | undefined;
  biome: string | undefined;
}

/** Whether one language's findings were measured, and how many: `unavailable` is never zero. */
export interface LanguageFindings {
  language: LanguageId;
  part: Part<number>;
}

export interface RunRecord {
  repo: RepoIdentity;
  /** Absolute path of the checkout the run looked at. */
  root: string;
  /** The subcommand, e.g. `verify`, `snapshot`, `time`. */
  command: string;
  /** ISO-8601 UTC, millisecond precision. */
  at: string;
  sha: string | undefined;
  branch: string | undefined;
  durationMs: number;
  exitCode: number;
  tools: ToolVersions;
  findings: Part<FindingsData>;
  overrides: Part<Override[]>;
  wiring: Part<WiringReport>;
  /** Metric name → value. Names are stable API: see METRIC_COLUMNS in schema.ts. */
  metrics: Part<Record<string, number>>;
  /** The languages the run checked; undefined when it checked none (metrics, time). */
  languages: LanguageId[] | undefined;
  /** Per-language findings status, one entry per language the run checked. */
  languageFindings: LanguageFindings[];
}

export type Tier = Severity;
