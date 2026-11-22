import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { match } from "ts-pattern";
import { recordedMetrics } from "./metrics.js";
import { aggregate } from "./metricsAggregate.js";
import { collectMetrics } from "./metricsCollect.js";
import { collectOverrides, type OverrideReport } from "./overrides.js";
import { driftMessage, presetDrift } from "./presetDrift.js";
import { type RunCollector, recordRun } from "./record/record.js";
import { repoMetrics } from "./record/repoMetrics.js";
import type { Part } from "./record/runRecord.js";
import { severityRaiseArgs } from "./severity.js";
import { collectVerifyFindings } from "./verify.js";
import { detectWiring } from "./wiring.js";

// `guardrails snapshot [path]`: observe one checkout and record it, whether
// or not that repo uses guardrails. It always records (GUARDRAILS_RECORD
// unset means the default database), never gates, and writes nothing into
// the repo it observes.
//
// Every part is attempted separately. A part that fails (a repo sgconfig
// pointing at a canon that is not installed, preset drift, a bad
// [[override]] table) is recorded `unavailable` with its reason and the
// others still run: a repo with no guardrails at all is wiring `off` with its
// metrics, not a failed snapshot.

function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split("\n")[0] ?? "";
}

/** Runs one measurement; a throw becomes `unavailable` with the error's first line. */
function attempt<T>(measure: () => T): Part<T> {
  try {
    return { status: "measured", scope: "full", data: measure() };
  } catch (err) {
    return { status: "unavailable", reason: firstLine(err) };
  }
}

function measure(run: RunCollector): void {
  const root = run.root;
  const overrides: Part<OverrideReport> = attempt(() => collectOverrides(root));
  run.overrides = match(overrides)
    .with({ status: "measured" }, (p) => ({ ...p, data: p.data.overrides }))
    .with({ status: "unavailable" }, { status: "skipped" }, (p) => p)
    .exhaustive();
  const report = match(overrides)
    .with({ status: "measured" }, (p) => p.data)
    .with({ status: "unavailable" }, { status: "skipped" }, () => undefined)
    .exhaustive();

  run.findings = attempt(() => {
    const drift = presetDrift(root);
    if (drift.length > 0) throw new Error(driftMessage(drift));
    const code = collectVerifyFindings(["."], severityRaiseArgs(root), root);
    return { tiers: "all" as const, list: [...code, ...(report?.findings ?? [])] };
  });
  run.wiring = attempt(() => detectWiring(root, report));
  run.metrics = attempt(() => {
    const m = aggregate(collectMetrics(["."]));
    return { ...recordedMetrics(m), ...repoMetrics(m, root) };
  });
}

function partLine<T>(name: string, part: Part<T>, summary: (data: T) => string): string {
  return match<Part<T>>(part)
    .with({ status: "measured" }, (p) => `${name} ${summary(p.data)}`)
    .with({ status: "unavailable" }, (p) => `${name} unavailable (${p.reason})`)
    .with({ status: "skipped" }, () => `${name} skipped`)
    .exhaustive();
}

export async function runSnapshot(
  targets: string[],
  json: boolean,
  run: RunCollector,
): Promise<number> {
  if (targets.length > 1) {
    console.error(`guardrails snapshot: one path at a time (got ${targets.length})`);
    return 2;
  }
  const root = resolve(targets[0] ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`guardrails snapshot: not a directory: ${root}`);
    return 2;
  }
  const startedAt = new Date();
  const started = performance.now();
  // The scanners read the current directory (ast-grep's .gitignore, the
  // repo's sgconfig.yml and project.toml), so the snapshot runs inside the
  // observed repo. The database path was resolved before this (RunCollector).
  process.chdir(root);
  run.root = root;
  measure(run);

  const outcome = await recordRun(run, {
    command: "snapshot",
    exitCode: 0,
    durationMs: performance.now() - started,
    startedAt,
  });
  const parts = [
    partLine("wiring", run.wiring, (w) => w.state),
    partLine("findings", run.findings, (f) => {
      const errors = f.list.filter((x) => x.severity === "error").length;
      return `${errors} error(s), ${f.list.length - errors} other`;
    }),
    partLine("overrides", run.overrides, (o) => `${o.length}`),
    partLine("metrics", run.metrics, (m) => `${Object.keys(m).length} recorded`),
  ];
  return match(outcome)
    .with({ status: "recorded" }, (o) => {
      if (json) {
        console.log(
          JSON.stringify({ command: "snapshot", root, db: o.db, runId: o.runId, parts }, null, 2),
        );
      } else {
        console.log(
          `guardrails snapshot: ${root} → ${o.db} (run ${o.runId})\n  ${parts.join("\n  ")}`,
        );
      }
      return 0;
    })
    .with({ status: "failed" }, () => 2)
    .with({ status: "off" }, () => {
      // resolveTarget(true) never yields "off"; reaching this is a defect.
      console.error("guardrails snapshot: recording was off — this is a guardrails bug");
      return 2;
    })
    .exhaustive();
}
