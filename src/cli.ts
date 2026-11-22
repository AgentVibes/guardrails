#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { match } from "ts-pattern";
import { runDeploy } from "./deploy.js";
import { runDoctor } from "./doctor.js";
import { runHookPostedit } from "./hookPostedit.js";
import { runHookStop } from "./hookStop.js";
import { runInit } from "./init.js";
import { runIterate } from "./iterate.js";
import { runLeaks } from "./leaks.js";
import { runMetrics } from "./metrics.js";
import { NOT_RECORDING, RunCollector, recordRun, resolveTarget } from "./record/record.js";
import { runSnapshot } from "./snapshot.js";
import { runTime } from "./time.js";
import { ToolMissingError } from "./toolResolve.js";
import { runVerify } from "./verify.js";
import { runVerifyDiff } from "./verifyDiff.js";

const USAGE = `guardrails — verification toolkit that makes agents write simple code

Usage:
  guardrails verify [paths...]        scan with the bundled rule canon (+ text
                                      greps + react structure); exit 1 on any
                                      error-tier finding
  guardrails verify-diff [--base R]   added-lines ratchet vs merge-base; exit 1
                                      only on error-tier findings your diff added
  guardrails doctor                   tool versions, ruleset SHA, config discovery
  guardrails init                     write repo stubs: sgconfig.yml, biome.json,
                                      [stack] in .agentvibes/project.toml
  guardrails metrics [paths...]       per-component/file/project metrics; with
                                      --check compares GATED metrics against the
                                      committed baseline (.guardrails/metrics.json)
                                      and exits 1 on any regression;
                                      --update-baseline [--force] tightens the
                                      baseline (2% hysteresis); --snapshot appends
                                      a JSONL trend row; --baseline <path> overrides

  guardrails snapshot [path]          record one checkout (default .) into the
                                      recording database, whether or not it
                                      uses guardrails; writes nothing into it;
                                      exit 2 only when the record fails

  guardrails time [--name N] -- CMD   run CMD, pass its output and exit code
                                      through; while recording, store its
                                      wall-clock time as metric N (build_ms)
                                      when it exits 0

  guardrails leaks [paths]            public/private boundary gate: scan for
                                      private-infrastructure markers and token
                                      patterns (+ gitleaks when available);
                                      exit 1 on any hit
  guardrails deploy [args...]         hand off to the project's deploy plugin
                                      (guardrails-plugin-* dep, or [deploy]
                                      plugin= in .agentvibes/project.toml);
                                      the public CLI carries no topology
  guardrails hook-postedit            Claude Code PostToolUse hook: reads hook
                                      JSON on stdin, scans the edited .ts/.tsx
                                      file on its changed lines; blocks on
                                      error-tier findings
  guardrails hook-stop                Claude Code Stop hook: verify-diff over
                                      the session's changed files; blocks
                                      "done" over new error-tier findings
                                      (max 3 blocks/session, then loud skip)
  guardrails iterate --task T --cmd C iterate-until-pass harness: run agent
                                      command, run the gate, feed findings
                                      back, repeat to green or --max (6)

All subcommands accept --json.
GUARDRAILS_RECORD=1 (or a database path) records verify, verify-diff, metrics,
hook-stop and time runs into SQLite; see README "Recording".
Exit codes: 0 ok · 1 findings/regression · 2 usage, missing tool, or missing baseline
`;

/** Commands whose runs are recorded when GUARDRAILS_RECORD is on (README "Recording"). */
const RECORDED = new Set(["verify", "verify-diff", "metrics", "hook-stop", "time"]);

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  // `time` runs another command: everything after the first `--` is that
  // command's argv, never our flags (`time -- tsc --help` must not print our help).
  // The command is the first argument that is not --json (`--json time …`).
  const separator = args.find((a) => a !== "--json") === "time" ? args.indexOf("--") : -1;
  const child = separator < 0 ? undefined : args.splice(separator).slice(1);
  const json = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");
  const command = filtered.shift();

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  const takeValueFlag = (flag: string): string | undefined | null => {
    const idx = filtered.indexOf(flag);
    if (idx < 0) return undefined;
    const value = filtered[idx + 1];
    // ast-grep-ignore: silent-default-return -- deliberate tri-state, not a fallback: null means "flag present but value missing" and every caller turns it into a usage error
    if (value === undefined) return null;
    filtered.splice(idx, 2);
    return value;
  };
  const takeBoolFlag = (flag: string): boolean => {
    const idx = filtered.indexOf(flag);
    if (idx < 0) return false;
    filtered.splice(idx, 1);
    return true;
  };

  const base = takeValueFlag("--base");
  if (base === null) {
    console.error("guardrails: --base requires a ref argument");
    return 2;
  }
  const baselinePath = takeValueFlag("--baseline");
  if (baselinePath === null) {
    console.error("guardrails: --baseline requires a path argument");
    return 2;
  }
  const patternsFile = takeValueFlag("--patterns") ?? undefined;
  const task = takeValueFlag("--task") ?? undefined;
  const cmd = takeValueFlag("--cmd") ?? undefined;
  const gateCmd = takeValueFlag("--gate") ?? undefined;
  const max = takeValueFlag("--max") ?? undefined;
  // Only `time` owns --name: `deploy` passes its arguments to a plugin as typed.
  const metricName = command === "time" ? takeValueFlag("--name") : undefined;
  if (metricName === null) {
    console.error("guardrails: --name requires a metric name");
    return 2;
  }
  const check = takeBoolFlag("--check");
  const updateBaseline = takeBoolFlag("--update-baseline");
  const force = takeBoolFlag("--force");
  const snapshot = takeBoolFlag("--snapshot");

  // `deploy` hands its args to a plugin verbatim, so its flags are not ours to
  // judge. Every other subcommand: `--help` is help, and any other leftover
  // `-x` is a usage error. Before this, an unknown flag fell through as a scan
  // TARGET — `metrics --help` reached ast-grep as `--help`, ast-grep printed
  // its own help text to stdout and exited 0, and the JSON parse crashed.
  if (command !== "deploy") {
    if (filtered.includes("--help") || filtered.includes("-h")) {
      console.log(USAGE);
      return 0;
    }
    const unknown = filtered.filter((a) => a.startsWith("-"));
    if (unknown.length > 0) {
      console.error(`guardrails ${command}: unknown option(s) ${unknown.join(" ")}\n`);
      console.error(USAGE);
      return 2;
    }
  }
  // Path targets must exist: ast-grep reports a missing path on stderr and
  // still exits 0 with an empty result, which would read as a clean scan.
  if (command === "verify" || command === "metrics" || command === "leaks") {
    const missing = filtered.filter((t) => !existsSync(t));
    if (missing.length > 0) {
      console.error(`guardrails ${command}: no such file or directory: ${missing.join(" ")}`);
      return 2;
    }
  }

  const recorded = RECORDED.has(command);
  // snapshot records by definition (an unset variable means the default
  // database) and writes its own record, so it is not in RECORDED.
  const run = new RunCollector(
    command === "snapshot" ? resolveTarget(true) : recorded ? resolveTarget() : NOT_RECORDING,
  );
  const startedAt = new Date();
  const started = performance.now();
  // ast-grep-ignore: non-exhaustive-match -- `command` is arbitrary CLI input (open string), not a closed union; the otherwise arm IS the unknown-subcommand error path
  const exitCode = match(command)
    .with("verify", () => runVerify(filtered, json, run))
    .with("verify-diff", () => runVerifyDiff(base, json, run))
    .with("doctor", () => runDoctor(json))
    .with("init", () => runInit(json))
    .with("metrics", () =>
      runMetrics({
        targets: filtered,
        json,
        check,
        updateBaseline,
        force,
        snapshot,
        baselinePath,
        run,
      }),
    )
    .with("leaks", () => runLeaks(filtered, json, patternsFile))
    .with("snapshot", () => runSnapshot(filtered, json, run))
    .with("deploy", () => runDeploy(filtered, json))
    .with("hook-postedit", () => runHookPostedit())
    .with("hook-stop", () => runHookStop(run))
    .with("time", () => runTime({ name: metricName, stray: filtered, child, json, run }))
    .with("iterate", () =>
      runIterate({
        task,
        cmd,
        gate: gateCmd,
        max: Number(max ?? 6),
        json,
        cliPath: fileURLToPath(import.meta.url),
      }),
    )
    .otherwise(() => {
      console.error(`guardrails: unknown subcommand '${command}'\n`);
      console.error(USAGE);
      return 2;
    });
  if (recorded && run.recording) {
    // The outcome is reported on stderr by recordRun; a run that could not be
    // recorded keeps its own exit code (a state database is not a gate).
    await recordRun(run, {
      command,
      exitCode: await exitCode,
      durationMs: performance.now() - started,
      startedAt,
    });
  }
  return exitCode;
}

// `exitCode`, never `process.exit()`: stdout to a pipe is asynchronous, and
// exiting outright dropped everything past the pipe's first 64 KiB of a
// `--json` report (is-5cc188b7). Node exits with this code once stdout drains.
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof ToolMissingError)) throw err;
  console.error(`guardrails: ${err.message}`);
  process.exitCode = 2;
}
