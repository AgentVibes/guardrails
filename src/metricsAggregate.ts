import type { CollectedMetrics } from "./metricsCollect.js";
import type { GatedMetrics, HookCounts, ObservedMetrics, ProjectMetrics } from "./metricsTypes.js";

/** Nearest-rank percentile over an unsorted sample; 0 for an empty sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export function aggregate(collected: CollectedMetrics): ProjectMetrics {
  const { components, files, store, inlineMapRowCount } = collected;
  const locs = components.map((c) => c.componentLoc);
  const contextCosts = files.map((f) => f.contextCost);
  const n = components.length;

  const hooksTotal: HookCounts = {
    useState: 0,
    useEffect: 0,
    useMemo: 0,
    useCallback: 0,
    useRef: 0,
  };
  let propsTotal = 0;
  let observerWrapped = 0;
  let maxJsxDepth = 0;
  let matchSites = 0;
  let exhaustive = 0;
  let otherwise = 0;
  let ternaryInJsx = 0;
  let andInJsx = 0;
  for (const c of components) {
    for (const k of Object.keys(hooksTotal) as (keyof HookCounts)[]) hooksTotal[k] += c.hooks[k];
    propsTotal += c.propsCount;
    if (c.observerWrapped) observerWrapped += 1;
    if (c.jsxMaxDepth > maxJsxDepth) maxJsxDepth = c.jsxMaxDepth;
    matchSites += c.branching.match;
    exhaustive += c.branching.exhaustive;
    otherwise += c.branching.otherwise;
    ternaryInJsx += c.branching.ternaryInJsx;
    andInJsx += c.branching.andInJsx;
  }

  const gated: GatedMetrics = {
    p90ComponentLoc: percentile(locs, 90),
    useStateDensity: n === 0 ? 0 : round(hooksTotal.useState / n),
    inlineMapRowCount,
    p90ContextCost: percentile(contextCosts, 90),
    runInActionCount: store.runInActionCount,
    asyncInStore: store.asyncInStore,
    newMapInStore: store.newMapInStore,
    reactionsTotal: store.reactionsTotal,
    loadingBooleanShapes: store.loadingBooleanShapes,
  };

  const observed: ObservedMetrics = {
    componentCount: n,
    fileCount: files.length,
    p50ComponentLoc: percentile(locs, 50),
    maxComponentLoc: locs.length === 0 ? 0 : Math.max(...locs),
    pctComponentsLe80: n === 0 ? 100 : round((100 * locs.filter((l) => l <= 80).length) / n, 1),
    observerWrappedPct: n === 0 ? 0 : round((100 * observerWrapped) / n, 1),
    hooksTotal,
    avgPropsCount: n === 0 ? 0 : round(propsTotal / n),
    maxJsxDepth,
    exhaustiveRatio: matchSites === 0 ? null : round(exhaustive / matchSites),
    matchSites,
    otherwiseCount: otherwise,
    ternaryInJsxCount: ternaryInJsx,
    andInJsxCount: andInJsx,
    p50FileSloc: percentile(
      files.map((f) => f.fileSloc),
      50,
    ),
    p90ContextCostObserved: percentile(contextCosts, 90),
  };

  return { gated, observed, components, files };
}
