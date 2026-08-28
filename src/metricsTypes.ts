export interface HookCounts {
  useState: number;
  useEffect: number;
  useMemo: number;
  useCallback: number;
  useRef: number;
}

export interface BranchingCounts {
  match: number;
  exhaustive: number;
  otherwise: number;
  ternaryInJsx: number;
  andInJsx: number;
}

export interface ComponentMetrics {
  file: string;
  name: string;
  line: number;
  /** span lines minus blank and comment-only lines — "does it fit on a screen" */
  componentLoc: number;
  hooks: HookCounts;
  /** properties in the destructured first parameter; 0 when not destructured */
  propsCount: number;
  observerWrapped: boolean;
  jsxMaxDepth: number;
  branching: BranchingCounts;
}

export interface FileMetrics {
  file: string;
  /** lines minus imports, blanks, comments */
  fileSloc: number;
  componentsPerFile: number;
  importedIdentifiers: number;
  /**
   * context-cost = imported identifiers (value + type) + props of the file's
   * components — how many foreign concepts a reader must hold to edit the file.
   */
  contextCost: number;
}

export interface StoreMetrics {
  /** canon rule store-no-runinaction(+tsx): runInAction in make(Auto)Observable classes */
  runInActionCount: number;
  /** canon rule store-async-method(+tsx): async store methods that should be flow() */
  asyncInStore: number;
  /** canon rule store-new-map(+tsx): plain-Map store fields that should be observable.map */
  newMapInStore: number;
  /** reaction( + autorun( call sites — the ~3-per-app budget; direct AST count (no rule yet) */
  reactionsTotal: number;
  /**
   * Boolean-shaped async-progress DECLARATIONS (`loading: boolean`,
   * `uploading = false`) — direct AST count, intentionally NOT the
   * state-loading-boolean-shape rule: the rule fires only on type-level shapes
   * with a second outcome/payload field, while this metric also counts the
   * lone class-field flags that are Resource<T>'s migration target.
   */
  loadingBooleanShapes: number;
}

/** The ratchet set (D7): direction for every one of these is LOWER = BETTER. */
export interface GatedMetrics {
  p90ComponentLoc: number;
  useStateDensity: number;
  inlineMapRowCount: number;
  p90ContextCost: number;
  runInActionCount: number;
  asyncInStore: number;
  newMapInStore: number;
  reactionsTotal: number;
  loadingBooleanShapes: number;
}

export interface ObservedMetrics {
  componentCount: number;
  fileCount: number;
  p50ComponentLoc: number;
  maxComponentLoc: number;
  pctComponentsLe80: number;
  observerWrappedPct: number;
  hooksTotal: HookCounts;
  avgPropsCount: number;
  maxJsxDepth: number;
  /** .exhaustive() / match( call sites; null when the project has no match sites */
  exhaustiveRatio: number | null;
  matchSites: number;
  otherwiseCount: number;
  ternaryInJsxCount: number;
  andInJsxCount: number;
  p50FileSloc: number;
  p90ContextCostObserved: number;
}

export interface ProjectMetrics {
  gated: GatedMetrics;
  observed: ObservedMetrics;
  components: ComponentMetrics[];
  files: FileMetrics[];
}

export interface Baseline {
  version: 1;
  updatedAt: string;
  commit: string | null;
  gated: GatedMetrics;
  /** informational only — --check always recomputes and never trusts this */
  observed: ObservedMetrics;
}
