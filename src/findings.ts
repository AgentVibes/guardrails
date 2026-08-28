export type Severity = "error" | "warning" | "info" | "hint";

export type FindingSource = "ast-grep" | "text-grep" | "structure";

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
