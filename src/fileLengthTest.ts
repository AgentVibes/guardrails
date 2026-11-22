import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// The file-length gate, both directions, plus the upgrade path. A baseline
// written before this metric existed must NOT go red on upgrade (the entry is
// missing, not zero); `--update-baseline` adopts it; after that, one more long
// file than the baseline fails `--check`. Test files never count, and
// `[metrics] max_file_lines` moves the limit.

const longFile = (lines: number): string =>
  `${Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;

function metrics(cwd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "metrics", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function expect(
  step: string,
  got: { status: number; out: string },
  want: number,
  text?: RegExp,
): boolean {
  if (got.status !== want || (text !== undefined && !text.test(got.out))) {
    console.error(
      `FAIL file-length: ${step} exited ${got.status}, expected ${want}${text === undefined ? "" : ` and output matching ${text}`}\n${got.out}`,
    );
    return false;
  }
  console.log(`  ok  file-length: ${step} → exit ${want}`);
  return true;
}

function filesOverLimit(cwd: string): number {
  const res = metrics(cwd, ["--json"]);
  const parsed = JSON.parse(res.out) as { gated: { filesOverLineLimit: number } };
  return parsed.gated.filesOverLineLimit;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-file-length-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "big.ts"), longFile(501));
    writeFileSync(join(dir, "src", "edge.ts"), longFile(500));
    writeFileSync(join(dir, "src", "big.test.ts"), longFile(900));

    const counted = filesOverLimit(dir);
    if (counted !== 1) {
      console.error(
        `FAIL file-length: expected 1 file over 500 (501 yes, 500 no, test no), got ${counted}`,
      );
      return 1;
    }
    console.log("  ok  file-length: 501 counts, 500 and the test file do not");

    // An old baseline: every gated key except the new one.
    if (!expect("--update-baseline (create)", metrics(dir, ["--update-baseline"]), 0)) return 1;
    const baselinePath = join(dir, ".guardrails", "metrics.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      gated: Record<string, number>;
    };
    delete baseline.gated.filesOverLineLimit;
    writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(join(dir, "src", "big2.ts"), longFile(700));
    if (
      !expect(
        "--check with a pre-upgrade baseline stays green",
        metrics(dir, ["--check"]),
        0,
        /filesOverLineLimit is not in the baseline yet/,
      )
    ) {
      return 1;
    }
    if (
      !expect(
        "--update-baseline adopts the new metric",
        metrics(dir, ["--update-baseline"]),
        0,
        /adopted\s+filesOverLineLimit → 2/,
      )
    ) {
      return 1;
    }
    if (!expect("--check after adoption", metrics(dir, ["--check"]), 0)) return 1;

    writeFileSync(join(dir, "src", "big3.ts"), longFile(650));
    if (
      !expect(
        "--check with one more long file goes RED",
        metrics(dir, ["--check"]),
        1,
        /filesOverLineLimit\s+baseline 2 → current 3[\s\S]*big3\.ts/,
      )
    ) {
      return 1;
    }

    mkdirSync(join(dir, ".agentvibes"));
    writeFileSync(join(dir, ".agentvibes", "project.toml"), "[metrics]\nmax_file_lines = 800\n");
    if (filesOverLimit(dir) !== 0) {
      console.error("FAIL file-length: max_file_lines = 800 should leave no file over the limit");
      return 1;
    }
    console.log("  ok  file-length: [metrics] max_file_lines moves the limit");

    writeFileSync(join(dir, ".agentvibes", "project.toml"), '[metrics]\nmax_file_lines = "many"\n');
    if (
      !expect("an invalid max_file_lines is a config error", metrics(dir, []), 2, /max_file_lines/)
    ) {
      return 1;
    }

    console.log("file-length gate passed");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
