import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import {
  baselineKey,
  checkFileSloc,
  describeViolation,
  FileSlocConfigError,
  type FileSlocUpdate,
  type FileSlocViolation,
  fileSlocBaselinePath,
  maxFileSloc,
  readFileSlocBaseline,
  updateFileSloc,
  writeFileSlocBaseline,
} from "./fileSlocBaseline.js";
import { renamesSinceBase } from "./fileSlocGate.js";
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
import { type RunCollector, scopeOf } from "./record/record.js";
import { repoMetrics } from "./record/repoMetrics.js";

export interface MetricsOptions {
  targets: string[];
  json: boolean;
  check: boolean;
  updateBaseline: boolean;
  force: boolean;
  snapshot: boolean;
  baselinePath: string | undefined;
  run: RunCollector;
}

/**
 * The project metrics as recorded names → numbers: every gated metric and
 * every numeric observed one under its JSON key, hook totals as
 * `hooksTotal.<hook>`. A null (no match sites) is not recorded.
 */
export function recordedMetrics(m: ProjectMetrics): Record<string, number> {
  const out: Record<string, number> = { ...m.gated };
  for (const [k, value] of Object.entries(m.observed)) {
    if (typeof value === "number") out[k] = value;
  }
  for (const [hook, n] of Object.entries(m.observed.hooksTotal)) out[`hooksTotal.${hook}`] = n;
  return out;
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

function measuredSloc(cwd: string, metrics: ProjectMetrics): Map<string, number> {
  return new Map(metrics.files.map((f) => [baselineKey(cwd, f.file), f.fileSloc]));
}

/** --update-baseline's half for the per-file length ratchet (.guardrails/file-sloc.json). */
function updateFileSlocBaseline(
  cwd: string,
  metrics: ProjectMetrics,
  force: boolean,
): FileSlocUpdate {
  const path = fileSlocBaselinePath(cwd);
  const old = match(readFileSlocBaseline(path))
    .with({ kind: "absent" }, () => undefined)
    .with({ kind: "present" }, (r) => r.baseline)
    .exhaustive();
  const result = updateFileSloc(
    old,
    measuredSloc(cwd, metrics),
    maxFileSloc(cwd),
    force,
    (key) => existsSync(join(cwd, key)),
    renamesSinceBase(cwd),
  );
  writeFileSlocBaseline(path, result.next);
  return result;
}

function printFileSlocUpdate(result: FileSlocUpdate, baselineRel: string): void {
  const listed = Object.keys(result.next.files).length;
  console.log(
    `guardrails metrics: ${baselineRel} — ${listed} file(s) over ${result.next.threshold} SLOC listed`,
  );
  for (const t of result.tightened) console.log(`  tightened  ${t.file} ${t.from} → ${t.to}`);
  for (const f of result.dropped) console.log(`  dropped    ${f} (under the limit or gone)`);
  for (const f of result.added) console.log(`  listed     ${f} → ${result.next.files[f]}`);
  for (const v of result.held) {
    console.log(
      `  NOT listed/raised (only --force does that): ${describeViolation(v, baselineRel)}`,
    );
  }
}

/** --check's half for the per-file length ratchet; an absent baseline grandfathers nothing. */
function checkFileSlocBaseline(cwd: string, metrics: ProjectMetrics): FileSlocViolation[] {
  const baseline = match(readFileSlocBaseline(fileSlocBaselinePath(cwd)))
    .with({ kind: "absent" }, () => ({}))
    .with({ kind: "present" }, (r) => r.baseline.files)
    .exhaustive();
  return checkFileSloc(
    measuredSloc(cwd, metrics),
    baseline,
    maxFileSloc(cwd),
    renamesSinceBase(cwd),
  );
}

export function runMetrics(opts: MetricsOptions): number {
  try {
    return runMetricsInner(opts);
  } catch (err) {
    if (!(err instanceof FileSlocConfigError)) throw err;
    console.error(`guardrails metrics: ${err.message}`);
    return 2;
  }
}

function runMetricsInner(opts: MetricsOptions): number {
  if (opts.check && opts.updateBaseline) {
    console.error("guardrails metrics: --check and --update-baseline are mutually exclusive");
    return 2;
  }
  const cwd = process.cwd();
  const baselinePath = opts.baselinePath ?? join(cwd, ".guardrails", "metrics.json");
  const snapshotPath = join(cwd, ".guardrails", "metrics-snapshots.jsonl");
  const targets = opts.targets.length > 0 ? opts.targets : ["."];

  const metrics = aggregate(collectMetrics(targets));
  const scope = scopeOf(targets);
  opts.run.addMetrics(scope, recordedMetrics(metrics));
  // Whole-repo extras only the record reads; not measured for a path subset.
  if (opts.run.recording && scope === "full") opts.run.addMetrics(scope, repoMetrics(metrics, cwd));
  const commit = headCommit(cwd);

  if (opts.snapshot) {
    appendSnapshot(snapshotPath, metrics.gated, metrics.observed, commit);
  }

  if (opts.updateBaseline) {
    const old = readBaseline(baselinePath);
    const result = updateGated(old?.gated, metrics.gated, opts.force);
    writeBaseline(baselinePath, result.next, metrics.observed, commit);
    const fileSloc = updateFileSlocBaseline(cwd, metrics, opts.force);
    const fileSlocRel = baselineKey(cwd, fileSlocBaselinePath(cwd));
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "metrics",
            action: "update-baseline",
            baselinePath,
            ...result,
            current: metrics.gated,
            fileSloc: { baselinePath: fileSlocRel, ...fileSloc },
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
    printFileSlocUpdate(fileSloc, fileSlocRel);
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
    const fileSloc = checkFileSlocBaseline(cwd, metrics);
    const fileSlocRel = baselineKey(cwd, fileSlocBaselinePath(cwd));
    const ok = regressions.length === 0 && fileSloc.length === 0;
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "metrics",
            action: "check",
            baselinePath,
            ok,
            regressions,
            current: metrics.gated,
            baseline: baseline.gated,
            fileSloc: { baselinePath: fileSlocRel, violations: fileSloc },
          },
          null,
          2,
        ),
      );
      return ok ? 0 : 1;
    }
    if (ok) {
      console.log(
        `guardrails metrics --check: OK — no gated metric regressed vs ${baselinePath}, no file over its length ceiling (baseline commit ${baseline.commit?.slice(0, 12) ?? "unknown"})`,
      );
      return 0;
    }
    if (regressions.length > 0) {
      console.log("guardrails metrics --check: RATCHET VIOLATION — gated metrics regressed:");
      for (const r of regressions) {
        console.log(`  ${r.metric.padEnd(22)} baseline ${r.baseline} → current ${r.current}`);
      }
    }
    if (fileSloc.length > 0) {
      console.log("guardrails metrics --check: RATCHET VIOLATION — file length:");
      for (const v of fileSloc) console.log(`  ${describeViolation(v, fileSlocRel)}`);
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
