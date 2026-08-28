import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { aggregate } from "./metricsAggregate.js";
import {
  appendSnapshot,
  checkAgainstBaseline,
  GATED_KEYS,
  readBaseline,
  updateGated,
  writeBaseline,
} from "./metricsBaseline.js";
import { collectMetrics } from "./metricsCollect.js";
import type { ProjectMetrics } from "./metricsTypes.js";

export interface MetricsOptions {
  targets: string[];
  json: boolean;
  check: boolean;
  updateBaseline: boolean;
  force: boolean;
  snapshot: boolean;
  baselinePath: string | undefined;
}

function headCommit(cwd: string): string | null {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (res.status !== 0 || res.error) return null;
  return res.stdout.trim();
}

function printReport(metrics: ProjectMetrics): void {
  const { gated, observed } = metrics;
  console.log(
    `guardrails metrics — ${observed.componentCount} component(s) in ${observed.fileCount} file(s)`,
  );
  console.log("gated (ratchet set, lower = better):");
  for (const key of GATED_KEYS) console.log(`  ${key.padEnd(22)} ${gated[key]}`);
  console.log("observed:");
  console.log(
    `  component_loc p50/p90/max   ${observed.p50ComponentLoc}/${gated.p90ComponentLoc}/${observed.maxComponentLoc}  (${observed.pctComponentsLe80}% ≤80)`,
  );
  console.log(
    `  hooks total                 useState=${observed.hooksTotal.useState} useEffect=${observed.hooksTotal.useEffect} useMemo=${observed.hooksTotal.useMemo} useCallback=${observed.hooksTotal.useCallback} useRef=${observed.hooksTotal.useRef}`,
  );
  console.log(
    `  observer_wrapped            ${observed.observerWrappedPct}%   avg props ${observed.avgPropsCount}   max JSX depth ${observed.maxJsxDepth}`,
  );
  console.log(
    `  exhaustive_ratio            ${observed.exhaustiveRatio ?? "n/a (no match sites)"} (${observed.matchSites} match sites, ${observed.otherwiseCount} .otherwise)`,
  );
  console.log(
    `  jsx branching               ternary=${observed.ternaryInJsxCount} &&=${observed.andInJsxCount}`,
  );
  console.log(`  file_sloc p50               ${observed.p50FileSloc}`);
}

export function runMetrics(opts: MetricsOptions): number {
  if (opts.check && opts.updateBaseline) {
    console.error("guardrails metrics: --check and --update-baseline are mutually exclusive");
    return 2;
  }
  const cwd = process.cwd();
  const baselinePath = opts.baselinePath ?? join(cwd, ".guardrails", "metrics.json");
  const snapshotPath = join(cwd, ".guardrails", "metrics-snapshots.jsonl");
  const targets = opts.targets.length > 0 ? opts.targets : ["."];

  const metrics = aggregate(collectMetrics(targets));
  const commit = headCommit(cwd);

  if (opts.snapshot) {
    appendSnapshot(snapshotPath, metrics.gated, metrics.observed, commit);
  }

  if (opts.updateBaseline) {
    const old = readBaseline(baselinePath);
    const result = updateGated(old?.gated, metrics.gated, opts.force);
    writeBaseline(baselinePath, result.next, metrics.observed, commit);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "metrics",
            action: "update-baseline",
            baselinePath,
            ...result,
            current: metrics.gated,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    console.log(
      old === undefined
        ? `guardrails metrics: baseline created at ${baselinePath}`
        : `guardrails metrics: baseline updated at ${baselinePath}${opts.force ? " (--force: set to current values)" : ""}`,
    );
    for (const k of result.tightened) console.log(`  tightened  ${k} → ${result.next[k]}`);
    for (const k of result.withinHysteresis) {
      console.log(`  kept       ${k} (improved <2% — hysteresis holds the old ceiling)`);
    }
    for (const k of result.worse) {
      console.log(
        `  kept       ${k} (current ${metrics.gated[k]} is WORSE than baseline ${result.next[k]} — not loosening without --force)`,
      );
    }
    return 0;
  }

  if (opts.check) {
    const baseline = readBaseline(baselinePath);
    if (baseline === undefined) {
      console.error(
        `guardrails metrics --check: no baseline at ${baselinePath} — create one with \`guardrails metrics --update-baseline\` and commit it.`,
      );
      return 2;
    }
    const regressions = checkAgainstBaseline(metrics.gated, baseline.gated);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "metrics",
            action: "check",
            baselinePath,
            ok: regressions.length === 0,
            regressions,
            current: metrics.gated,
            baseline: baseline.gated,
          },
          null,
          2,
        ),
      );
      return regressions.length === 0 ? 0 : 1;
    }
    if (regressions.length === 0) {
      console.log(
        `guardrails metrics --check: OK — no gated metric regressed vs ${baselinePath} (baseline commit ${baseline.commit?.slice(0, 12) ?? "unknown"})`,
      );
      return 0;
    }
    console.log("guardrails metrics --check: RATCHET VIOLATION — gated metrics regressed:");
    for (const r of regressions) {
      console.log(`  ${r.metric.padEnd(22)} baseline ${r.baseline} → current ${r.current}`);
    }
    console.log(
      "Improve the code back under the baseline. Loosening the baseline itself requires\n`guardrails metrics --update-baseline --force` and belongs in a reviewed commit.",
    );
    return 1;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          command: "metrics",
          targets,
          gated: metrics.gated,
          observed: metrics.observed,
          components: metrics.components,
          files: metrics.files,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  printReport(metrics);
  if (opts.snapshot) console.log(`snapshot appended to ${snapshotPath}`);
  return 0;
}
