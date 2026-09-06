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

/** ast-grep could not load a config, so nothing was scanned with it. */
export class AstGrepConfigError extends Error {}

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
export function scan(
  configPath: string,
  targets: string[],
  extraArgs: string[] = [],
): AstGrepRow[] {
  const tool = resolveTool("ast-grep");
  const [cmd, ...prefix] = tool.argv;
  if (cmd === undefined) throw new Error("empty ast-grep argv");
  const res = spawnSync(
    cmd,
    [...prefix, "scan", "-c", configPath, ...extraArgs, "--json", ...targets],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (res.error) throw res.error;
  const out = res.stdout.trim();
  // Exit 0 = clean scan, 1 = the scan ran and found error-tier matches (stdout
  // carries them either way). Everything else means ast-grep never scanned:
  // 6 is an unreadable ruleDir, 8 an unparsable config. Returning [] there
  // would report "no findings" for a rule set that never loaded — the exact
  // silence this package exists to remove. Measured against ast-grep 0.45.2.
  const status = res.status ?? -1;
  if (out === "") {
    if (status === 0) return [];
    throw new AstGrepConfigError(
      `ast-grep exited ${status} and scanned nothing with config ${configPath}. ` +
        `Its output:\n${res.stderr.trim().slice(0, 2000)}`,
    );
  }
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
export function scanFindings(
  configPath: string,
  targets: string[],
  extraArgs: string[] = [],
): Finding[] {
  return scan(configPath, targets, extraArgs)
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
