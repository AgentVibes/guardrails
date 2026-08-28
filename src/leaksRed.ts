import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Gate-can-go-red test for `guardrails leaks`: a fixture file carrying a
// private-infrastructure marker must turn the gate red, and a clean file must
// not. The marker is ASSEMBLED at runtime from halves so this test's own
// source never contains it — otherwise the repo's self-scan (which this test
// exists to keep honest) would flag the test.

const MARKER = ["byok", "api.com"].join("");
const TOKENISH = ["ghp_", "a".repeat(36)].join("");

function leaks(target: string): number {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "leaks", target], {
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return res.status ?? -1;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-leaks-red-"));
  try {
    const badFile = join(dir, "config.ts");
    writeFileSync(
      badFile,
      `export const apiBase = "https://svc.${MARKER}";\nconst t = "${TOKENISH}";\n`,
    );
    const badExit = leaks(dir);
    if (badExit !== 1) {
      console.error(
        `FAIL leaks-red: leaks on a dir containing an infra marker + token exited ${badExit}, expected 1 — the leak gate cannot go red`,
      );
      return 1;
    }
    console.log("  ok  leaks-red: marker + token fixture → leaks exit 1 (gate goes red)");

    rmSync(badFile);
    writeFileSync(join(dir, "clean.ts"), 'export const apiBase = "https://example.invalid";\n');
    const goodExit = leaks(dir);
    if (goodExit !== 0) {
      console.error(`FAIL leaks-red: leaks on a clean dir exited ${goodExit}, expected 0`);
      return 1;
    }
    console.log("  ok  leaks-red: clean dir → leaks exit 0 (gate goes green)");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
