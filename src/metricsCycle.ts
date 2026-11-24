import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A baseline written before a gated metric existed has no key for it. --check
 * must report it as not yet gated (exit 0), not compare it with 0, and
 * --update-baseline must adopt its current value so the next worsening is red.
 */
function notYetGatedCycle(dir: string, wideFile: string): boolean {
  const baselinePath = join(dir, ".guardrails", "metrics.json");
  writeFileSync(wideFile, BAD_COMPONENT);
  if (
    !expectStatus(
      "--update-baseline --force (with the wide component)",
      metrics(dir, ["--update-baseline", "--force"]),
      0,
    )
  )
    return false;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    gated: Record<string, number>;
  };
  const density = baseline.gated.useStateDensity;
  if (density === undefined || density <= 0) {
    console.error(`FAIL metrics-cycle: fixture should have useStateDensity > 0, got ${density}`);
    return false;
  }
  delete baseline.gated.useStateDensity;
  writeFileSync(baselinePath, JSON.stringify(baseline));

  const check = metrics(dir, ["--check"]);
  if (!expectStatus("--check with a gated key missing from the baseline", check, 0)) return false;
  if (!check.out.includes("useStateDensity is not in the baseline yet")) {
    console.error(
      `FAIL metrics-cycle: --check did not print the not-yet-gated notice\n${check.out}`,
    );
    return false;
  }
  const json = metrics(dir, ["--check", "--json"]);
  if (!expectStatus("--check --json with a missing key", json, 0)) return false;
  const report = JSON.parse(json.out) as { notYetGated: string[] };
  if (JSON.stringify(report.notYetGated) !== JSON.stringify(["useStateDensity"])) {
    console.error(`FAIL metrics-cycle: notYetGated = ${JSON.stringify(report.notYetGated)}`);
    return false;
  }

  const update = metrics(dir, ["--update-baseline"]);
  if (!expectStatus("--update-baseline adopts the missing key", update, 0)) return false;
  if (!update.out.includes("adopted    useStateDensity")) {
    console.error(
      `FAIL metrics-cycle: --update-baseline did not report the adoption\n${update.out}`,
    );
    return false;
  }
  const adopted = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    gated: Record<string, number>;
  };
  if (adopted.gated.useStateDensity === undefined) {
    console.error("FAIL metrics-cycle: the adopted key is not in the written baseline");
    return false;
  }

  // Now gated: a second useState raises the density and must be red.
  writeFileSync(
    join(dir, "src", "Two.tsx"),
    `import { useState } from "react";
export const Two = () => {
  const [a] = useState(0);
  const [b] = useState(1);
  return <p>{a + b}</p>;
};
`,
  );
  return expectStatus("--check after worsening the adopted metric", metrics(dir, ["--check"]), 1);
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

    if (!notYetGatedCycle(dir, wideFile)) return 1;

    console.log("metrics baseline cycle passed");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
