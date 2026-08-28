import { spawnSync } from "node:child_process";
import type { Finding, Severity } from "./findings.js";
import { resolveTool } from "./toolResolve.js";

interface AstGrepMatch {
  ruleId: string;
  severity: Severity;
  file: string;
  message: string;
  range: { start: { line: number }; end: { line: number } };
  metaVariables?: { single?: Record<string, { text?: string }> };
}

export interface AstGrepRow {
  ruleId: string;
  file: string;
  /** 1-based */
  startLine: number;
  /** inclusive line span of the matched node */
  spanLines: number;
  severity: Severity;
  message: string;
  metaText: (name: string) => string | undefined;
}

/** Run `ast-grep scan -c <config> --json` and return structured matches. */
export function scan(configPath: string, targets: string[]): AstGrepRow[] {
  const tool = resolveTool("ast-grep");
  const [cmd, ...prefix] = tool.argv;
  if (cmd === undefined) throw new Error("empty ast-grep argv");
  const res = spawnSync(cmd, [...prefix, "scan", "-c", configPath, "--json", ...targets], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  const out = res.stdout.trim();
  if (out === "") return [];
  let parsed: AstGrepMatch[];
  try {
    parsed = JSON.parse(out) as AstGrepMatch[];
  } catch {
    throw new Error(
      `ast-grep produced unparsable JSON (exit ${res.status}). stderr:\n${res.stderr.slice(0, 2000)}`,
    );
  }
  return parsed.map((m) => ({
    ruleId: m.ruleId,
    file: m.file,
    startLine: m.range.start.line + 1,
    spanLines: m.range.end.line - m.range.start.line + 1,
    severity: m.severity,
    message: m.message,
    metaText: (name: string) => m.metaVariables?.single?.[name]?.text,
  }));
}

/** Reportable (error/warning) rule findings, dropping marker/hint tiers. */
export function scanFindings(configPath: string, targets: string[]): Finding[] {
  return scan(configPath, targets)
    .filter((r) => r.severity === "error" || r.severity === "warning")
    .map((r) => ({
      rule: r.ruleId,
      severity: r.severity,
      file: r.file,
      line: r.startLine,
      message: r.message,
      source: "ast-grep" as const,
    }));
}
