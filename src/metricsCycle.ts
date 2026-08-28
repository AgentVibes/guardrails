import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Baseline-cycle autotest: init baseline → worsen the code → --check goes RED →
// improve back → --check green → tighten baseline → worsen again → RED again.
// This is the metrics twin of gateRed.ts: a ratchet that has never been seen
// red proves nothing.

const GOOD_COMPONENT = `export const Row = ({ id, name }: { id: string; name: string }) => {
  return <li>{name}</li>;
};
`;

// Worse on two GATED axes: useStateDensity (a useState appears) and
// p90ComponentLoc (a second, much longer component raises the p90).
const LONG_BODY = Array.from({ length: 95 }, (_, i) => `  const v${i} = ${i};`).join("\n");
const BAD_COMPONENT = `import { useState } from "react";
export const Wide = () => {
  const [n, setN] = useState(0);
${LONG_BODY}
  return <button onClick={() => setN(n + 1)}>{n}</button>;
};
`;

function metrics(cwd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "metrics", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function expectStatus(step: string, got: { status: number; out: string }, want: number): boolean {
  if (got.status !== want) {
    console.error(`FAIL metrics-cycle: ${step} exited ${got.status}, expected ${want}\n${got.out}`);
    return false;
  }
  console.log(`  ok  metrics-cycle: ${step} → exit ${want}`);
  return true;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-metrics-cycle-"));
  try {
    mkdirSync(join(dir, "src"));
    const rowFile = join(dir, "src", "Row.tsx");
    const wideFile = join(dir, "src", "Wide.tsx");
    writeFileSync(rowFile, GOOD_COMPONENT);

    if (!expectStatus("--check with no baseline", metrics(dir, ["--check"]), 2)) return 1;
    if (!expectStatus("--update-baseline (create)", metrics(dir, ["--update-baseline"]), 0))
      return 1;
    if (!expectStatus("--check on unchanged code", metrics(dir, ["--check"]), 0)) return 1;

    writeFileSync(wideFile, BAD_COMPONENT);
    if (!expectStatus("--check after worsening", metrics(dir, ["--check"]), 1)) return 1;

    if (
      !expectStatus(
        "--update-baseline while worse (must not loosen)",
        metrics(dir, ["--update-baseline"]),
        0,
      )
    ) {
      return 1;
    }
    if (!expectStatus("--check still red (baseline held)", metrics(dir, ["--check"]), 1)) return 1;

    rmSync(wideFile);
    if (!expectStatus("--check after improving back", metrics(dir, ["--check"]), 0)) return 1;

    if (
      !expectStatus(
        "--update-baseline --force (tighten)",
        metrics(dir, ["--update-baseline", "--force"]),
        0,
      )
    ) {
      return 1;
    }
    writeFileSync(wideFile, BAD_COMPONENT);
    if (!expectStatus("--check after worsening again", metrics(dir, ["--check"]), 1)) return 1;

    console.log("metrics baseline cycle passed");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
