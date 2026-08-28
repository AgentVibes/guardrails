import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Baseline, GatedMetrics, ObservedMetrics } from "./metricsTypes.js";

// Ratchet mechanics (D7). Direction for every gated metric is LOWER = BETTER.
// `--check` always RECOMPUTES the facts and compares against the committed
// baseline file — it never believes the file's own numbers. Tightening happens
// only through `--update-baseline`, and only when a metric improved by more
// than the hysteresis (~2%), so a noise-level fluctuation cannot latch an
// accidental ceiling; `--force` overrides in both directions (loosening a
// baseline is a reviewed decision visible in the diff, not something the tool
// does on its own).

export const HYSTERESIS = 0.02;
const EPS = 1e-9;

export const GATED_KEYS: (keyof GatedMetrics)[] = [
  "p90ComponentLoc",
  "useStateDensity",
  "inlineMapRowCount",
  "p90ContextCost",
  "runInActionCount",
  "asyncInStore",
  "newMapInStore",
  "reactionsTotal",
  "loadingBooleanShapes",
];

export interface Regression {
  metric: keyof GatedMetrics;
  baseline: number;
  current: number;
}

export function readBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  if (parsed.version !== 1 || typeof parsed.gated !== "object") {
    throw new Error(
      `baseline at ${path} has an unrecognised shape — regenerate with --update-baseline --force`,
    );
  }
  return parsed;
}

export function checkAgainstBaseline(current: GatedMetrics, baseline: GatedMetrics): Regression[] {
  const regressions: Regression[] = [];
  for (const key of GATED_KEYS) {
    const base = baseline[key] ?? 0;
    const cur = current[key];
    if (cur > base + EPS + Math.abs(base) * EPS) {
      regressions.push({ metric: key, baseline: base, current: cur });
    }
  }
  return regressions;
}

export interface UpdateResult {
  next: GatedMetrics;
  tightened: (keyof GatedMetrics)[];
  /** improved, but by less than the hysteresis — kept the old ceiling */
  withinHysteresis: (keyof GatedMetrics)[];
  /** currently worse than baseline — kept the old ceiling (no silent loosening) */
  worse: (keyof GatedMetrics)[];
}

export function updateGated(
  old: GatedMetrics | undefined,
  current: GatedMetrics,
  force: boolean,
): UpdateResult {
  if (old === undefined || force) {
    return {
      next: { ...current },
      tightened: force ? [] : GATED_KEYS,
      withinHysteresis: [],
      worse: [],
    };
  }
  const next = { ...old };
  const tightened: (keyof GatedMetrics)[] = [];
  const withinHysteresis: (keyof GatedMetrics)[] = [];
  const worse: (keyof GatedMetrics)[] = [];
  for (const key of GATED_KEYS) {
    const base = old[key] ?? 0;
    const cur = current[key];
    if (cur < base * (1 - HYSTERESIS) - EPS) {
      next[key] = cur;
      tightened.push(key);
    } else if (cur > base + EPS) {
      worse.push(key);
    } else if (cur < base - EPS) {
      withinHysteresis.push(key);
    }
  }
  return { next, tightened, withinHysteresis, worse };
}

export function writeBaseline(
  path: string,
  gated: GatedMetrics,
  observed: ObservedMetrics,
  commit: string | null,
): void {
  const baseline: Baseline = {
    version: 1,
    updatedAt: new Date().toISOString(),
    commit,
    gated,
    observed,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export function appendSnapshot(
  path: string,
  gated: GatedMetrics,
  observed: ObservedMetrics,
  commit: string | null,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ timestamp: new Date().toISOString(), commit, gated, observed })}\n`,
  );
}
