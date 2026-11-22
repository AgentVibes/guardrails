import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packageRoot } from "./packagePaths.js";

// `guardrails time [--name N] -- CMD`. The red cases: the child's exit code
// must come back unchanged (a wrapper that turns a failed build green breaks
// every CI that uses it); a failed build must not record a build time; flags
// after `--` belong to the child; a time run must not blank the other
// metric columns of the repo's latest row.

const CLI = join(packageRoot, "dist", "cli.js");
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `\n  ${detail}`}`);
}

function rows(db: string, sql: string): Record<string, unknown>[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    d.close();
  }
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-time-"));
  const db = join(dir, "state", "g.sqlite");
  const rec = { GUARDRAILS_RECORD: db };
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const git = (...a: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...a]);
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@example.com:demo/timed.git");
    git("add", ".");
    git("commit", "-qm", "init");

    const off = cli(dir, ["time", "--", "node", "-e", "process.stdout.write('out')"]);
    check(
      "with recording off the command runs, its output passes through, exit 0",
      off.status === 0 && off.stdout === "out" && /build_ms=\d+/.test(off.stderr),
      `${off.status} ${off.stdout} ${off.stderr}`,
    );

    const failing = cli(dir, ["time", "--", "node", "-e", "process.exit(3)"], rec);
    check("the child's exit code comes back unchanged", failing.status === 3, failing.stderr);
    check(
      "a failed run is recorded with its exit code and no build time",
      rows(db, "SELECT exit_code FROM runs WHERE command = 'time'")[0]?.exit_code === 3 &&
        rows(db, "SELECT status FROM run_parts WHERE part = 'metrics'")[0]?.status ===
          "unavailable" &&
        rows(db, "SELECT * FROM metric_history").length === 0,
      JSON.stringify(rows(db, "SELECT * FROM run_parts")),
    );

    const snap = cli(dir, ["snapshot"], rec);
    const ok = cli(dir, ["time", "--", "node", "-e", "setTimeout(() => {}, 50)"], rec);
    const latest = rows(db, "SELECT build_ms, sloc, files FROM projects_latest")[0];
    check(
      "a successful run records build_ms and keeps the other metric columns",
      snap.status === 0 &&
        ok.status === 0 &&
        typeof latest?.build_ms === "number" &&
        latest.build_ms >= 50 &&
        latest.sloc === 1 &&
        latest.files === 1,
      `${JSON.stringify(latest)} ${snap.stderr} ${ok.stderr}`,
    );

    const named = cli(dir, ["time", "--name", "test_ms", "--", "node", "-e", ""], rec);
    const history = rows(db, "SELECT metric FROM metric_history WHERE metric = 'test_ms'");
    check(
      "--name records under that metric name",
      named.status === 0 && history.length === 1,
      named.stderr,
    );

    const help = cli(dir, ["time", "--", "node", "--help"]);
    check(
      "flags after -- belong to the command, not to guardrails",
      help.status === 0 && /node/.test(help.stdout) && !/guardrails —/.test(help.stdout),
      help.stdout.slice(0, 200),
    );
    check("a command without -- is a usage error", cli(dir, ["time", "node"]).status === 2);
    check("no command is a usage error", cli(dir, ["time", "--"]).status === 2);
    check(
      "a bad --name is a usage error",
      cli(dir, ["time", "--name", "Build Time", "--", "node", "-e", ""]).status === 2,
    );
    check(
      "a command that cannot start exits 127",
      cli(dir, ["time", "--", "guardrails-no-such-command"]).status === 127,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`\n${failed} time check(s) failed`);
    return 1;
  }
  console.log("\ntime passed");
  return 0;
}

process.exitCode = main();
