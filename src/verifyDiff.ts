import { join, relative } from "node:path";
import { match } from "ts-pattern";
import { scanFindings } from "./astGrep.js";
import { type Finding, formatFinding } from "./findings.js";
import { addedLines, changedFiles, gitRoot, resolveMergeBase } from "./gitDiff.js";
import { rulesConfig } from "./packagePaths.js";
import { SeverityConfigError, severityRaiseArgs } from "./severity.js";
import { structureFindings } from "./structure.js";
import { readTomlTable } from "./tomlTable.js";

// Added-lines ratchet, ported from defensive-errors check-diff.sh, with the
// hook-postedit.sh fallback ladder instead of check-diff's "skip when no base".
// A CI gate can afford to skip on a missing base ref because CI fails loudly
// elsewhere; a CLI an agent runs has no such backstop, so every rung degrades
// to MORE coverage, never to silence:
//
//   1. merge-base resolves  -> gate error-tier findings on ADDED lines of
//                              changed files (untracked file = every line added).
//   2. repo, no merge base  -> gate ALL error-tier findings in changed +
//                              untracked files (whole-file tier).
//   3. not a git repo       -> gate all error-tier findings under cwd.
//
// Warning-tier findings and text-greps never gate; brownfield findings on
// untouched lines never gate on rung 1.

type Rung =
  | { kind: "added-lines"; root: string; mergeBase: string }
  | { kind: "whole-file"; root: string }
  | { kind: "whole-tree" };

interface Plan {
  rungLabel: string;
  files: string[] | undefined;
  /** undefined = gate every error finding; otherwise gate only listed lines/files. */
  keep: (f: Finding) => boolean;
}

/**
 * `[verify] exclude = "<regex>"` in .agentvibes/project.toml — a VENDORED-tree
 * carve-out, ported from merkle's check-diff.sh: a verbatim copy of somebody
 * else's package must not be held to this repo's rules (editing it to satisfy
 * them would turn the next upstream re-sync into a merge conflict and falsify
 * the byte-identical provenance that is the reason to vendor). The regex tests
 * the file path relative to the repo root.
 */
export function verifyExcludeRe(cwd: string): RegExp | undefined {
  const raw = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "verify").exclude;
  if (raw === undefined || raw === "") return undefined;
  return new RegExp(raw);
}

function resolveRung(cwd: string, base: string | undefined): Rung {
  const root = gitRoot(cwd);
  if (root === undefined) return { kind: "whole-tree" };
  const mb = resolveMergeBase(root, base);
  if (mb === undefined) return { kind: "whole-file", root };
  return { kind: "added-lines", root, mergeBase: mb };
}

function planFor(rung: Rung): Plan {
  return match(rung)
    .with({ kind: "whole-tree" }, () => ({
      rungLabel: "whole-tree (not a git repository — nothing to diff against, gating everything)",
      files: undefined,
      keep: () => true,
    }))
    .with({ kind: "whole-file" }, ({ root }) => {
      const { tracked, untracked } = changedFiles(root, "HEAD");
      return {
        rungLabel:
          "whole-file (no resolvable base ref — gating every line of changed/untracked files)",
        files: [...new Set([...tracked, ...untracked])],
        keep: () => true,
      };
    })
    .with({ kind: "added-lines" }, ({ root, mergeBase }) => {
      const { tracked, untracked } = changedFiles(root, mergeBase);
      const untrackedSet = new Set(untracked);
      const addedByFile = new Map<string, Set<number>>();
      return {
        rungLabel: `added-lines vs merge-base ${mergeBase.slice(0, 12)}`,
        files: [...new Set([...tracked, ...untracked])],
        keep: (f: Finding) => {
          if (untrackedSet.has(f.file)) return true;
          let added = addedByFile.get(f.file);
          if (added === undefined) {
            added = addedLines(root, mergeBase, f.file);
            addedByFile.set(f.file, added);
          }
          return added.has(f.line);
        },
      };
    })
    .exhaustive();
}

export function runVerifyDiff(base: string | undefined, json: boolean): number {
  let severityArgs: string[];
  try {
    severityArgs = severityRaiseArgs(process.cwd());
  } catch (err) {
    if (err instanceof SeverityConfigError) {
      console.error(`guardrails verify-diff: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const plan = planFor(resolveRung(process.cwd(), base));
  const exclude = verifyExcludeRe(process.cwd());
  if (exclude !== undefined && plan.files !== undefined) {
    // changedFiles yields absolute paths; the exclude regex (donor precedent:
    // '^packages/site-chrome/') is written against repo-root-relative ones.
    plan.files = plan.files.filter((f) => !exclude.test(relative(process.cwd(), f)));
  }
  const targets = plan.files ?? ["."];

  if (plan.files !== undefined && plan.files.length === 0) {
    report(json, plan.rungLabel, 0, [], "no changed .ts/.tsx files — nothing to gate");
    return 0;
  }

  const gated = [...scanFindings(rulesConfig, targets, severityArgs), ...structureFindings(targets)]
    .filter((f) => f.severity === "error")
    .filter(plan.keep);

  const filesScanned = plan.files?.length ?? -1;
  report(
    json,
    plan.rungLabel,
    filesScanned,
    gated,
    gated.length === 0
      ? "OK — no new error-tier findings"
      : `${gated.length} new ERROR-tier finding(s)`,
  );
  return gated.length === 0 ? 0 : 1;
}

function report(
  json: boolean,
  rung: string,
  files: number,
  gated: Finding[],
  summary: string,
): void {
  if (json) {
    console.log(
      JSON.stringify(
        { command: "verify-diff", rung, filesScanned: files, violations: gated, summary },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`guardrails verify-diff — ${rung}`);
  for (const f of gated) console.log(formatFinding(f));
  console.log(`guardrails verify-diff: ${summary}`);
  if (gated.length > 0) {
    console.log(
      "Fix these, or suppress a genuine false positive with a justified comment on the line above:\n  // ast-grep-ignore: <rule-id> -- <why this is legitimate>",
    );
  }
}
