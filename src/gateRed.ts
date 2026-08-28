import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// The gate-can-go-red test. A CI step that only ever sees green input proves
// nothing — `|| echo warning` gates and no-op lint scripts stay green forever,
// and that anti-pattern is what this package exists to kill. So `pnpm check`
// runs the verifier against a deliberately bad file and FAILS unless the
// verifier fails, then against a clean file and fails unless it passes.

const BAD_SOURCE = `interface Payload { id: string }
export function decode(raw: unknown): Payload {
  return raw as any;
}
`;

const GOOD_SOURCE = `export function double(n: number): number {
  return n * 2;
}
`;

function verify(target: string): number {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "verify", target], {
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return res.status ?? -1;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-gate-red-"));
  try {
    const badFile = join(dir, "deliberatelyBad.ts");
    writeFileSync(badFile, BAD_SOURCE);
    const badExit = verify(badFile);
    if (badExit !== 1) {
      console.error(
        `FAIL gate-red: verify on a file containing \`as any\` exited ${badExit}, expected 1 — the gate cannot go red`,
      );
      return 1;
    }
    console.log("  ok  gate-red: deliberately bad file → verify exit 1 (gate goes red)");

    const goodFile = join(dir, "deliberatelyGood.ts");
    writeFileSync(goodFile, GOOD_SOURCE);
    const goodExit = verify(goodFile);
    if (goodExit !== 0) {
      console.error(`FAIL gate-red: verify on a clean file exited ${goodExit}, expected 0`);
      return 1;
    }
    console.log("  ok  gate-red: clean file → verify exit 0 (gate goes green)");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
