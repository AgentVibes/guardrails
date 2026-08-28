import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rulesDir } from "./packagePaths.js";
import { readTomlTable } from "./tomlTable.js";

// Per-repo severity RAISE — `[severity]` in .agentvibes/project.toml:
//
//   [severity]
//   zod-optional-nullable = "error"
//
// RAISE-ONLY by design: adoption must never weaken a gate (ratchet-first), so
// a repo that held a rule at error before adopting the canon keeps it there —
// but the reverse direction is refused: downgrades already have sanctioned
// homes (warn-tier biome deviations; `[verify] exclude` for vendored trees;
// per-line ast-grep-ignore with a written reason), and a quiet [severity]
// downgrade would be a gate-weakening bypass of all three. The raise reaches
// ast-grep as its native `--error=<rule-id>` flag, so a repo-local fork of the
// rule (same id, different severity — a silent drift the README forbids) is
// never needed.

export class SeverityConfigError extends Error {}

/** id -> canonical severity, parsed once from the bundled rule files. */
function canonSeverities(): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of readdirSync(rulesDir)) {
    if (!f.endsWith(".yml")) continue;
    const text = readFileSync(join(rulesDir, f), "utf8");
    const id = text.match(/^id:\s*(\S+)/m)?.[1];
    const severity = text.match(/^severity:\s*(\S+)/m)?.[1];
    if (id !== undefined && severity !== undefined) map.set(id, severity);
  }
  return map;
}

/**
 * ast-grep CLI args implementing the repo's [severity] raises; [] when none.
 * Throws SeverityConfigError on an unknown rule id or a non-raise target —
 * a config the gate cannot honour must fail loudly (exit 2), never be
 * silently dropped.
 */
export function severityRaiseArgs(cwd: string): string[] {
  const table = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "severity");
  const entries = Object.entries(table);
  if (entries.length === 0) return [];

  const canon = canonSeverities();
  const args: string[] = [];
  for (const [ruleId, target] of entries) {
    const current = canon.get(ruleId);
    if (current === undefined) {
      throw new SeverityConfigError(
        `[severity] names unknown rule '${ruleId}' — not in the bundled canon (repo-local extras keep their own severity in their own yml).`,
      );
    }
    if (target !== "error") {
      throw new SeverityConfigError(
        `[severity] ${ruleId} = "${target}" — only raises to "error" are allowed. Downgrade paths: a warn-tier deviation in biome config, [verify] exclude for vendored trees, or a justified per-line ast-grep-ignore.`,
      );
    }
    if (current === "error") continue;
    args.push(`--error=${ruleId}`);
  }
  return args;
}
