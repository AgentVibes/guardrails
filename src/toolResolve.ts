import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { miseToml } from "./packagePaths.js";

export interface ResolvedTool {
  /** argv prefix to run the tool, e.g. ["ast-grep"] or ["mise", "x", "ast-grep@0.45.2", "--", "ast-grep"]. */
  argv: string[];
  via: "path" | "mise";
  version: string;
}

export class ToolMissingError extends Error {
  constructor(tool: string, hint: string) {
    super(`${tool} not found on PATH and mise is unavailable. Install it: ${hint}`);
    this.name = "ToolMissingError";
  }
}

/** Version pins live in mise.toml only — one source of truth for CLI, CI, and hosts. */
export function pinnedVersion(tool: string): string | undefined {
  const text = readFileSync(miseToml, "utf8");
  const m = text.match(new RegExp(`^${tool.replace(/[-]/g, "\\-")}\\s*=\\s*"([^"]+)"`, "m"));
  return m?.[1];
}

function probe(argv: string[]): string | undefined {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return undefined;
  const res = spawnSync(cmd, [...args, "--version"], { encoding: "utf8" });
  if (res.status !== 0 || res.error) return undefined;
  return res.stdout.trim().split("\n")[0];
}

/**
 * PATH first, `mise x <tool>@<pin>` as the fallback, one-line install hint as
 * the failure — the opt-hook.sh philosophy: never hard-require a specific
 * install route, never silently continue without the tool either.
 */
export function resolveTool(tool: string): ResolvedTool {
  const direct = probe([tool]);
  if (direct !== undefined) return { argv: [tool], via: "path", version: direct };

  const pin = pinnedVersion(tool);
  const spec = pin === undefined ? tool : `${tool}@${pin}`;
  const viaMise = probe(["mise", "x", spec, "--", tool]);
  if (viaMise !== undefined) {
    return { argv: ["mise", "x", spec, "--", tool], via: "mise", version: viaMise };
  }

  throw new ToolMissingError(tool, `mise use -g ${tool}@${pin ?? "latest"}`);
}

export function tryResolveTool(tool: string): ResolvedTool | undefined {
  try {
    return resolveTool(tool);
  } catch {
    return undefined;
  }
}
