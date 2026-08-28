import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { type Finding, formatFinding } from "./findings.js";
import { addedLines, gitRoot, resolveMergeBase } from "./gitDiff.js";
import { collectVerifyFindings } from "./verify.js";
import { verifyExcludeRe } from "./verifyDiff.js";

// Claude Code PostToolUse hook — port of defensive-errors hook-postedit.sh.
// Reads the hook JSON on stdin; scans the just-edited TypeScript file; silent
// unless there are findings. Error-tier findings on lines the edit changed
// emit {decision:"block"}; warnings attach as additionalContext.
//
// The changed-lines ladder (whole-file is the ONLY terminal fallback — when
// the changed lines cannot be computed the fallback is noise, never silence):
//   1. Write            -> whole file (Write replaces the file wholesale)
//   2. untracked file   -> whole file (every line is new)
//   3. merge-base found -> the changed lines vs merge-base(HEAD, base) — the
//                          only narrowing path; a local branch sitting at HEAD
//                          is rejected (committing would launder findings)
//   4. anything else    -> whole file
//
// In whole-file mode, structure findings (component size / one-per-file) are
// newness-tiered vs HEAD: a finding anchored on a line this working tree added
// is the agent's own doing and blocks; an inherited one only warns — a flat
// error tier would turn a one-line fix in a legacy 300-line component into a
// mandatory refactor.

interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

const SUPPRESS =
  "False positive? Suppress a specific finding with a justified comment on the line above it:\n// ast-grep-ignore: <rule-id> -- <why this is legitimate>\nThe scan honors it and will not re-flag that line.";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function isTracked(root: string, file: string): boolean {
  const res = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", file], {
    encoding: "utf8",
  });
  return res.status === 0;
}

/** undefined = whole file (ladder rungs 1/2/4); a Set = rung 3's changed lines. */
function changedLines(tool: string, file: string): Set<number> | undefined {
  if (tool === "Write") return undefined;
  const root = gitRoot(dirname(file));
  if (root === undefined) return undefined;
  if (!isTracked(root, file)) return undefined;
  const mb = resolveMergeBase(root);
  if (mb === undefined) return undefined;
  return addedLines(root, mb, file);
}

/** Lines this working tree added vs HEAD — the newness test for structure tiering. */
function newLines(file: string): Set<number> | undefined {
  const root = gitRoot(dirname(file));
  if (root === undefined) return undefined;
  if (!isTracked(root, file)) return undefined;
  return addedLines(root, "HEAD", file);
}

export function runHookPostedit(): number {
  let input: HookInput;
  try {
    input = JSON.parse(readStdin()) as HookInput;
  } catch {
    return 0;
  }
  const tool = input.tool_name ?? "";
  const file = input.tool_input?.file_path ?? "";
  if (tool !== "Edit" && tool !== "Write") return 0;
  const configDir = process.env.AGENT_CONFIG_DIR;
  if (configDir !== undefined && configDir !== "" && file.startsWith(`${configDir}/`)) return 0;
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return 0;
  // ast-grep-ignore: silent-default-return -- a hook fires on deletes/renames too; a vanished file has nothing to scan and hooks must never fail the edit (donor hook-postedit.sh line `[ -f "$FILE" ] || exit 0`)
  if (!existsSync(file)) return 0;

  // Honour the repo's `[verify] exclude` carve-out (vendored trees) the same
  // way verify-diff does — an edit inside a vendored copy is not gated.
  const repoRoot = gitRoot(dirname(file));
  if (
    repoRoot !== undefined &&
    verifyExcludeRe(repoRoot)?.test(relative(repoRoot, file)) === true
  ) {
    return 0;
  }

  let findings: Finding[] = collectVerifyFindings([file]);

  const lines = changedLines(tool, file);
  if (lines !== undefined) {
    // An EMPTY set is a real answer (a revert git already collapsed) — there
    // is nothing of the agent's to gate. Only failure to COMPUTE degrades.
    findings = findings.filter((f) => lines.has(f.line));
  } else {
    const fresh = newLines(file);
    findings = findings.map((f) =>
      f.source === "structure" && f.severity === "error" && !(fresh?.has(f.line) ?? true)
        ? { ...f, severity: "warning" as const }
        : f,
    );
  }

  if (findings.length === 0) return 0;

  const rendered = findings.map(formatFinding).join("\n").split("\n").slice(0, 60).join("\n");
  const base = file.split("/").pop() ?? file;

  if (findings.some((f) => f.severity === "error")) {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: `guardrails scan found ERROR-tier violations in ${base}:\n\n${rendered}\n\nFix these before continuing. ${SUPPRESS}\nRule rationale: the defensive-errors and mobx-models skills; \`guardrails verify --help\`.`,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `guardrails scan flagged warnings in ${base}:\n\n${rendered}\n\nAddress these or, if a finding is a false positive, suppress it. ${SUPPRESS}`,
        },
      }),
    );
  }
  return 0;
}
