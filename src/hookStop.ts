import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFinding } from "./findings.js";
import { runVerifyDiffCollect } from "./verifyDiff.js";

// Claude Code Stop hook — the "cannot say done over red findings" echelon
// (spec layer C). On Stop it runs the verify-diff ratchet over the session's
// changed files; new error-tier findings emit {decision:"block"} so the agent
// must finish the cleanup before finishing the turn.
//
// Two safety properties, both load-bearing:
//   - LOOP BREAKER: after N blocks in one session (default 3, env
//     GUARDRAILS_STOP_MAX_BLOCKS) the hook stops blocking and prints a LOUD
//     warning instead — an agent wedged forever behind its own gate is worse
//     than undercleaned code, and a self-imposed stop must never become a
//     parked loop. The block counter is per session_id in the OS tmpdir.
//   - SELF-DEFECT RULE (same as hook-postedit): the hook never fails the Stop
//     because of its own defects — any internal error degrades to silent
//     allow; CI's verify-diff fails loudly on the same state instead.

interface StopInput {
  session_id?: string;
  stop_hook_active?: boolean;
}

const MAX_BLOCKS = Number(process.env.GUARDRAILS_STOP_MAX_BLOCKS ?? 3);

function counterPath(sessionId: string): string {
  const dir = join(tmpdir(), "guardrails-stop");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.count`);
}

function readCount(path: string): number {
  // ast-grep-ignore: silent-default-return -- a missing counter file IS the zero-blocks state, not a masked failure
  if (!existsSync(path)) return 0;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(n) ? n : 0;
}

export function runHookStop(): number {
  try {
    let input: StopInput;
    try {
      input = JSON.parse(readFileSync(0, "utf8")) as StopInput;
    } catch {
      return 0;
    }
    const sessionId = input.session_id ?? "unknown-session";

    const { violations } = runVerifyDiffCollect(process.cwd(), undefined);
    if (violations.length === 0) return 0;

    const path = counterPath(sessionId);
    const blocks = readCount(path);
    const rendered = violations.map(formatFinding).join("\n").split("\n").slice(0, 40).join("\n");

    if (blocks >= MAX_BLOCKS) {
      // Loud skip, never a fourth block: the warning goes to stderr (visible
      // in the transcript) and names what was left red.
      console.error(
        `guardrails hook-stop: SKIPPING the block — this session was already stopped ${blocks}x by this gate (max ${MAX_BLOCKS}). ${violations.length} error-tier finding(s) REMAIN on the session's changed lines:\n${rendered}\nRun \`guardrails verify-diff\` and fix them; CI will hold the same line.`,
      );
      return 0;
    }
    writeFileSync(path, String(blocks + 1));

    const finalWarning =
      blocks + 1 === MAX_BLOCKS
        ? `\n(This is block ${blocks + 1}/${MAX_BLOCKS} — the next Stop will NOT be blocked; CI still will.)`
        : "";
    console.log(
      JSON.stringify({
        decision: "block",
        reason: `guardrails verify-diff: ${violations.length} error-tier finding(s) on lines this session changed — finish the cleanup before stopping:\n\n${rendered}\n\nFix these, or suppress a genuine false positive with a justified comment on the line above:\n// ast-grep-ignore: <rule-id> -- <why this is legitimate>${finalWarning}`,
      }),
    );
    return 0;
  } catch {
    // Self-defect rule: a broken hook must not wedge the session.
    return 0;
  }
}
