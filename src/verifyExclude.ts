import { join } from "node:path";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { readTomlTable } from "./tomlTable.js";

/**
 * `[verify] exclude = "<regex>"` in .agentvibes/project.toml — a VENDORED-tree
 * carve-out, ported from a consumer's check-diff.sh: a verbatim copy of somebody
 * else's package must not be held to this repo's rules (editing it to satisfy
 * them would turn the next upstream re-sync into a merge conflict and falsify
 * the byte-identical provenance that is the reason to vendor). The regex tests
 * the file path relative to the repo root.
 *
 * A leaf module: the Cargo root discovery reads it too, and verifyDiff.ts
 * imports that discovery. A pattern that is not a regular expression is an
 * OverrideConfigError (exit 2 with the reason), never a stack trace.
 */
export function verifyExcludeRe(cwd: string): RegExp | undefined {
  const raw = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "verify").exclude;
  if (raw === undefined || raw === "") return undefined;
  try {
    return new RegExp(raw);
  } catch (e) {
    throw new OverrideConfigError(
      `.agentvibes/project.toml: [verify] exclude = "${raw}" is not a regular expression: ${(e as Error).message}`,
    );
  }
}
