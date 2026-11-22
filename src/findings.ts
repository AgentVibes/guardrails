export type Severity = "error" | "warning" | "info" | "hint";

import { match } from "ts-pattern";

export type FindingSource =
  | "ast-grep"
  | "text-grep"
  | "structure"
  | "override"
  | "clippy"
  | "rustc"
  | "rustfmt";

/** The program that produced a finding, as the record's `tool` column names it. */
export type FindingTool = "ast-grep" | "guardrails" | "clippy" | "rustc" | "rustfmt";

export function toolOf(source: FindingSource): FindingTool {
  return match(source)
    .with("ast-grep", () => "ast-grep" as const)
    .with("text-grep", "structure", "override", () => "guardrails" as const)
    .with("clippy", () => "clippy" as const)
    .with("rustc", () => "rustc" as const)
    .with("rustfmt", () => "rustfmt" as const)
    .exhaustive();
}

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
  source: FindingSource;
}

export function formatFinding(f: Finding): string {
  const firstLine = f.message.split("\n")[0] ?? "";
  return `${f.severity}[${f.rule}]: ${f.file}:${f.line}\n  ${firstLine}`;
}

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

/** A finding from the Rust toolchain (clippy, rustc lints, rustfmt). */
export function isRustFinding(f: Finding): boolean {
  return f.source === "clippy" || f.source === "rustc" || f.source === "rustfmt";
}
