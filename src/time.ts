import { spawn } from "node:child_process";
import { constants } from "node:os";
import { match, P } from "ts-pattern";
import type { RunCollector } from "./record/record.js";

// `guardrails time [--name N] -- <cmd> [args...]`: run a command, pass its
// output and exit code through, and record its wall-clock time as metric N
// (default `build_ms`) when recording is on (GUARDRAILS_RECORD). Only a run
// that exits 0 records the number: a build that failed halfway is not a
// build time, and a trend of half-builds would hide a real slowdown. A
// failed run is still recorded, with the metric `unavailable` and why.

/** A metric name: what `metric_history.metric` and the README promise. */
const METRIC_NAME = /^[a-z][a-z0-9_.]*$/;

export const DEFAULT_TIME_METRIC = "build_ms";

export type ChildResult =
  | { kind: "exited"; code: number }
  | { kind: "signalled"; signal: NodeJS.Signals }
  | { kind: "not-started"; error: string };

/** Runs the command with inherited stdio, without a shell: argv goes to it as typed. */
function runChild(file: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit" });
    child.on("error", (err) => resolve({ kind: "not-started", error: err.message }));
    child.on("exit", (code, signal) =>
      resolve(
        match({ code, signal })
          .with({ signal: P.string }, (s) => ({ kind: "signalled", signal: s.signal }) as const)
          .with({ code: P.number }, (s) => ({ kind: "exited", code: s.code }) as const)
          // Node documents one of the two as set; both null would be a Node defect.
          .with({ code: null, signal: null }, () => ({
            kind: "not-started" as const,
            error: "the process ended with neither an exit code nor a signal",
          }))
          .exhaustive(),
      ),
    );
  });
}

/** The shell convention: 127 when the command could not start, 128 + n for signal n. */
export function exitCodeOf(r: ChildResult): number {
  return match(r)
    .with({ kind: "exited" }, (x) => x.code)
    .with({ kind: "signalled" }, (x) => 128 + (constants.signals[x.signal] ?? 0))
    .with({ kind: "not-started" }, () => 127)
    .exhaustive();
}

function describe(r: ChildResult): string {
  return match(r)
    .with({ kind: "exited" }, (x) => `exit ${x.code}`)
    .with({ kind: "signalled" }, (x) => `killed by ${x.signal}`)
    .with({ kind: "not-started" }, (x) => `could not start: ${x.error}`)
    .exhaustive();
}

export async function runTime(opts: {
  name: string | undefined;
  /** Arguments before `--`: a command typed without the separator. */
  stray: readonly string[];
  child: readonly string[] | undefined;
  json: boolean;
  run: RunCollector;
}): Promise<number> {
  const name = opts.name ?? DEFAULT_TIME_METRIC;
  if (!METRIC_NAME.test(name)) {
    console.error(
      `guardrails time: --name must match ${METRIC_NAME.source} (lower case, digits, _ and .), got '${name}'`,
    );
    return 2;
  }
  const [file, ...args] = opts.child ?? [];
  if (file === undefined || opts.stray.length > 0) {
    console.error("guardrails time: give the command after --, e.g. guardrails time -- pnpm build");
    return 2;
  }

  const started = performance.now();
  const result = await runChild(file, args);
  const ms = Math.round(performance.now() - started);
  const ok = match(result)
    .with({ kind: "exited" }, (x) => x.code === 0)
    .with({ kind: "signalled" }, { kind: "not-started" }, () => false)
    .exhaustive();
  if (ok) {
    opts.run.addMetrics("full", { [name]: ms });
  } else {
    opts.run.metrics = { status: "unavailable", reason: `${file}: ${describe(result)}` };
  }

  const recorded = ok && opts.run.recording;
  if (opts.json) {
    console.error(
      JSON.stringify({ command: "time", metric: name, ms, result: describe(result), recorded }),
    );
  } else {
    console.error(
      `guardrails time: ${name}=${ms} (${describe(result)})${recorded ? "" : ok ? ", not recorded (GUARDRAILS_RECORD is off)" : ", not recorded as a time"}`,
    );
  }
  return exitCodeOf(result);
}
