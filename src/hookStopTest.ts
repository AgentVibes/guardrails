import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Fixtures for the Stop hook: block on red, silent on green, and the loop
// breaker — after max blocks the hook SKIPS loudly instead of wedging the
// session forever behind its own gate.

function stop(cwd: string, sessionId: string): { status: number; out: string; err: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "hook-stop"], {
    cwd,
    input: JSON.stringify({ session_id: sessionId }),
    encoding: "utf8",
    env: { ...process.env, GUARDRAILS_STOP_MAX_BLOCKS: "2" },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: res.stdout, err: res.stderr };
}

function expectStep(step: string, ok: boolean, detail: string): boolean {
  if (!ok) {
    console.error(`FAIL hook-stop: ${step}\n${detail}`);
    return false;
  }
  console.log(`  ok  hook-stop: ${step}`);
  return true;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-hookstop-"));
  const session = `hookstop-test-${Date.now()}`;
  try {
    const git = (...args: string[]): void => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q");
    writeFileSync(join(dir, "clean.ts"), "export const ok = 1;\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

    const green = stop(dir, session);
    if (
      !expectStep(
        "clean session → silent allow",
        green.status === 0 && green.out.trim() === "",
        `${green.out}${green.err}`,
      )
    ) {
      return 1;
    }

    writeFileSync(join(dir, "sessionWork.ts"), "export const boom = (x: unknown) => x as any;\n");
    const b1 = stop(dir, session);
    if (
      !expectStep(
        "red session → block 1 with findings",
        b1.status === 0 &&
          b1.out.includes('"decision":"block"') &&
          b1.out.includes("as-any-escape"),
        b1.out,
      )
    ) {
      return 1;
    }
    const b2 = stop(dir, session);
    if (
      !expectStep(
        "block 2/2 carries the final warning",
        b2.out.includes('"decision":"block"') && b2.out.includes("will NOT be blocked"),
        b2.out,
      )
    ) {
      return 1;
    }
    const b3 = stop(dir, session);
    if (
      !expectStep(
        "block 3 → loop breaker: loud SKIP on stderr, no block",
        b3.status === 0 &&
          !b3.out.includes("block") &&
          b3.err.includes("SKIPPING") &&
          b3.err.includes("as-any-escape"),
        `${b3.out}\n${b3.err}`,
      )
    ) {
      return 1;
    }

    console.log("hook-stop fixtures passed");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
