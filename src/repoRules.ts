import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Repo-local rules (is-f58cd6b4). `guardrails init` writes an `sgconfig.yml`
// into the consuming repo and the README tells people to add a second
// `ruleDir` for rules that encode ONE repo's convention — but `verify` and
// `verify-diff` only ever scanned with the PACKAGE's own sgconfig.yml, so
// those rules never ran. Both the intranet (`resource-match-exhaustive`) and
// DataSpool (`no-connector-fs`, `no-global-fetch`) worked around it by adding a
// bare `ast-grep scan -c sgconfig.yml` as a second gate stage.
//
// The failure mode is this package's least favourite: `verify` printed a
// finding count, and the count was of a strictly smaller rule set than the
// repo had asked for. Nothing said so.
//
// The fix scans with BOTH configs and merges. Not "the repo's config instead
// of ours": a repo whose sgconfig.yml forgets the canon `ruleDir` would then
// silently lose the entire canon, which is the same bug pointing the other
// way. The canon is always scanned; the repo's config is additive; duplicate
// findings (the repo's config almost always lists the canon dir too, so every
// canon finding arrives twice) are deduped by rule + file + line.

/** A repo config that ast-grep could not load. */
export class RepoConfigError extends Error {}

/**
 * The consuming repo's own `sgconfig.yml`, or undefined when there is none.
 *
 * Returns undefined when `cwd` IS this package: scanning our own config twice
 * would double every finding in our own fixtures and tests.
 */
export function repoRuleConfig(cwd: string): string | undefined {
  if (resolve(cwd) === resolve(packageRoot)) return undefined;
  const path = join(cwd, "sgconfig.yml");
  if (!existsSync(path)) return undefined;
  return path;
}

/** Every ast-grep config `verify` should scan with, canon first. */
export function ruleConfigs(cwd: string, canon: string): string[] {
  const repo = repoRuleConfig(cwd);
  return repo === undefined ? [canon] : [canon, repo];
}

/**
 * `ruleDirs:` as written in a repo config — for `doctor`, so a repo can see
 * WHICH extra rule directories its config contributes rather than only that a
 * config exists. Deliberately a line reader, not a YAML parse: this is a
 * report, and a config shape it cannot read must not stop `doctor` from
 * running (ast-grep is the authority on whether the file loads, and the strict
 * scan in `astGrep.ts` is what reports that).
 */
export function declaredRuleDirs(configPath: string): string[] {
  const dirs: string[] = [];
  let inRuleDirs = false;
  for (const line of readFileSync(configPath, "utf8").split("\n")) {
    if (/^ruleDirs:/.test(line)) {
      inRuleDirs = true;
      continue;
    }
    if (inRuleDirs) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (item?.[1] !== undefined) {
        dirs.push(item[1]);
        continue;
      }
      if (line.trim() === "" || line.startsWith(" ") || line.startsWith("#")) continue;
      inRuleDirs = false;
    }
  }
  return dirs;
}

/** Findings from several configs, minus the duplicates the overlap produces. */
export function dedupeFindings<T extends { rule: string; file: string; line: number }>(
  findings: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of findings) {
    const key = `${f.rule}\0${f.file}\0${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
