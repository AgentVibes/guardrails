// NOTHING in this file may be reported by `store-no-runinaction`.
import { flow, makeAutoObservable } from "mobx"

// The fix: a flow. Every yield point resumes inside an action, so there is
// nothing left for runInAction to wrap.
export class GitStore {
  loading = false
  branch: string | null = null

  constructor() {
    makeAutoObservable(this)
  }

  refresh = flow(function* (this: GitStore, dir: string) {
    this.loading = true
    this.branch = yield readBranch(dir)
    this.loading = false
  })
}

// A plain class with no MobX annotation is not a store. `runInAction` here
// would be pointless rather than banned, and this rule is about stores.
export class PlainCache {
  entries: string[] = []

  add(entry: string): void {
    this.entries.push(entry)
  }
}

// A module-level helper that is not inside any store class.
export function describeBranch(branch: string): string {
  return `on ${branch}`
}

// Importing the symbol is not calling it. The report's "66 runInAction in
// SiteCraft" counted 7 import lines exactly like this one; the real call-site
// count is 59.
export { runInAction } from "mobx"
