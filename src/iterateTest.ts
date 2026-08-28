import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Fixtures for the iterate harness, with a fake "agent" instead of an LLM:
//   1. converging agent — writes a violation on attempt 1, fixes it on
//      attempt 2 (because the feedback loop told it to) → GREEN in 2 attempts
//   2. stubborn agent — keeps the violation every attempt → exit 1 at --max
// Also pins the feedback contract: attempt 2's prompt file must contain the
// gate's findings from attempt 1.

function iterate(cwd: string, agentScript: string, max: number): { status: number; out: string } {
  const res = spawnSync(
    "node",
    [
      join(packageRoot, "dist", "cli.js"),
      "iterate",
      "--task",
      "Implement the widget per spec.",
      "--cmd",
      `node ${agentScript}`,
      "--max",
      String(max),
    ],
    { cwd, encoding: "utf8" },
  );
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function expectStep(step: string, ok: boolean, detail: string): boolean {
  if (!ok) {
    console.error(`FAIL iterate: ${step}\n${detail}`);
    return false;
  }
  console.log(`  ok  iterate: ${step}`);
  return true;
}

function gitRepo(dir: string): void {
  const git = (...args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  writeFileSync(join(dir, "base.ts"), "export const ok = 1;\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

const CONVERGING_AGENT = `
const fs = require("node:fs");
const attempt = Number(process.env.GUARDRAILS_ATTEMPT);
const prompt = fs.readFileSync(process.env.GUARDRAILS_PROMPT_FILE, "utf8");
if (attempt === 1) {
  fs.writeFileSync("widget.ts", "export const w = (x: unknown) => x as any;\\n");
} else {
  // The harness contract: the retry prompt carries the gate's findings.
  if (!prompt.includes("as-any-escape")) { console.error("no feedback in prompt"); process.exit(9); }
  fs.writeFileSync("widget.ts", "export const w = (x: number): number => x;\\n");
}
`;

const STUBBORN_AGENT = `
const fs = require("node:fs");
fs.writeFileSync("widget.ts", "export const w = (x: unknown) => x as any;\\n");
`;

function main(): number {
  const base = mkdtempSync(join(tmpdir(), "guardrails-iterate-test-"));
  try {
    const conv = join(base, "conv");
    const stub = join(base, "stub");
    for (const d of [conv, stub]) {
      spawnSync("mkdir", ["-p", d]);
      gitRepo(d);
    }
    writeFileSync(join(conv, "agent.cjs"), CONVERGING_AGENT);
    writeFileSync(join(stub, "agent.cjs"), STUBBORN_AGENT);

    const green = iterate(conv, "agent.cjs", 4);
    if (
      !expectStep(
        "converging agent → green on attempt 2 via feedback",
        green.status === 0 && green.out.includes("GREEN after 2 attempt(s)"),
        green.out,
      )
    ) {
      return 1;
    }

    const red = iterate(stub, "agent.cjs", 2);
    if (
      !expectStep(
        "stubborn agent → exit 1 at --max with last findings",
        red.status === 1 &&
          red.out.includes("still red after 2 attempt(s)") &&
          red.out.includes("as-any-escape"),
        red.out,
      )
    ) {
      return 1;
    }

    console.log("iterate fixtures passed");
    return 0;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

process.exit(main());
