// NOTHING in this file may be reported by `store-new-map`.
import { makeAutoObservable, observable } from "mobx"

export class GalleryStore {
  // The fix: mutations are tracked.
  entries = observable.map<string, Row>()

  constructor() {
    makeAutoObservable(this)
  }
}

// The LEGAL pattern the rule must not break: a private cache explicitly
// annotated non-observable. Nothing renders from it, so a plain Map is right.
export class MainPageStore {
  private _jobInfoCache = new Map<string, JobInfo>()
  jobs: Job[] = []

  constructor() {
    makeAutoObservable(this, { _jobInfoCache: false })
  }
}

// Several exempted fields at once.
export class MetricsStore {
  private counters = new Map<string, number>()
  private gauges = new Map<string, number>()
  total = 0

  constructor() {
    makeAutoObservable(this, { counters: false, gauges: false })
  }
}

// Not a store: a plain service class.
export class MetricsService {
  private counters = new Map<string, number>()
}

// Module-level constant, not a store field.
export const REGISTRY = new Map<string, string>()
