import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Gate-can-go-red tests for `guardrails leaks`:
//   1. a fixture with a credential-shaped string (built-in generic pattern)
//      turns the gate red, a clean dir does not;
//   2. the runtime pattern-loading mechanism works — a `.guardrails/leaks.txt`
//      pattern fires on matching content, and the pattern file itself is
//      exempt from the scan (it necessarily contains its own markers).
// The token is ASSEMBLED from halves so this test's own source never
// contains a credential-shaped string.

const TOKENISH = ["ghp_", "a".repeat(36)].join("");

function leaks(cwd: string, target: string): number {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "leaks", target], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return res.status ?? -1;
}

function expectExit(step: string, got: number, want: number): boolean {
  if (got !== want) {
    console.error(`FAIL leaks-red: ${step} exited ${got}, expected ${want}`);
    return false;
  }
  console.log(`  ok  leaks-red: ${step} → exit ${want}`);
  return true;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-leaks-red-"));
  try {
    const badFile = join(dir, "config.ts");
    writeFileSync(badFile, `const t = "${TOKENISH}";\n`);
    if (!expectExit("token-shaped fixture (gate goes red)", leaks(dir, "."), 1)) return 1;

    rmSync(badFile);
    writeFileSync(join(dir, "clean.ts"), 'export const apiBase = "https://example.invalid";\n');
    if (!expectExit("clean dir (gate goes green)", leaks(dir, "."), 0)) return 1;

    // Runtime pattern loading: a repo-local pattern file arms a marker the
    // public package does not know.
    mkdirSync(join(dir, ".guardrails"));
    writeFileSync(join(dir, ".guardrails", "leaks.txt"), "custom-marker examplecorp-internal\n");
    writeFileSync(join(dir, "infra.ts"), 'const host = "examplecorp-internal.example";\n');
    if (!expectExit("repo-local pattern fires (leaks.txt mechanism)", leaks(dir, "."), 1)) return 1;

    // The pattern file itself must be exempt — it contains its own marker.
    rmSync(join(dir, "infra.ts"));
    if (!expectExit("pattern file self-exempt (green with only leaks.txt)", leaks(dir, "."), 0)) {
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
