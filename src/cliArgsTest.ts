import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Argument handling. `guardrails metrics --help` used to crash: the CLI passed
// every unrecognised flag through as a scan target, ast-grep received `--help`,
// printed its own help to stdout with exit 0, and the JSON parse threw. Each
// case below names the exit code the CLI must give, and a stack trace on
// stderr fails the case whatever the code.

interface Case {
  name: string;
  args: string[];
  want: number;
}

const CASES: Case[] = [
  { name: "metrics --help prints usage", args: ["metrics", "--help"], want: 0 },
  { name: "verify -h prints usage", args: ["verify", "-h"], want: 0 },
  { name: "verify --bogus is a usage error", args: ["verify", "--bogus"], want: 2 },
  { name: "metrics --bogus is a usage error", args: ["metrics", "--bogus", "."], want: 2 },
  { name: "leaks --bogus is a usage error", args: ["leaks", "--bogus"], want: 2 },
  { name: "verify on a missing path", args: ["verify", "no-such-dir"], want: 2 },
  { name: "metrics on a missing path", args: ["metrics", "no-such-dir"], want: 2 },
  { name: "metrics on a real dir", args: ["metrics", "."], want: 0 },
];

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-cli-args-"));
  let failed = 0;
  try {
    writeFileSync(join(dir, "ok.ts"), "export const x = 1;\n");
    for (const c of CASES) {
      const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), ...c.args], {
        cwd: dir,
        encoding: "utf8",
      });
      if (res.error) throw res.error;
      const crashed = /\n\s+at /.test(res.stderr);
      if (res.status !== c.want || crashed) {
        console.error(
          `FAIL cli-args: ${c.name}: exit ${res.status}, expected ${c.want}${crashed ? " (stack trace)" : ""}\n${res.stderr.slice(0, 800)}`,
        );
        failed += 1;
        continue;
      }
      console.log(`  ok  cli-args: ${c.name} → exit ${c.want}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed === 0 ? 0 : 1;
}

process.exit(main());
