// Every runInAction call in this file MUST be reported by `store-no-runinaction`.
import { makeAutoObservable, runInAction } from "mobx"

export class GitStore {
  loading = false
  branch: string | null = null

  constructor() {
    makeAutoObservable(this)
  }

  async refresh(dir: string): Promise<void> {
    runInAction(() => {
      this.loading = true
    })
    const branch = await readBranch(dir)
    runInAction(() => {
      this.branch = branch
      this.loading = false
    })
  }

  // Nested inside a callback — still inside the store class.
  subscribe(): void {
    onChange(() => {
      runInAction(() => {
        this.branch = null
      })
    })
  }
}

// The generic-argument spelling of the annotation. A `pattern:
// makeAutoObservable($$$)` does not match a call carrying explicit type
// arguments, which is how SiteCraft's project.store.ts — 7 real call sites —
// went missing from the first version of this rule.
export class ProjectStore {
  private _buildTimer: number | null = null
  projects: string[] = []

  constructor() {
    makeAutoObservable<this, "_buildTimer">(this, { _buildTimer: false })
  }

  async load(): Promise<void> {
    const list = await fetchProjects()
    runInAction(() => {
      this.projects = list
    })
  }
}

// `makeObservable` is the other spelling of the same thing.
export class SessionStore {
  items: string[] = []

  constructor() {
    makeObservable(this, { items: observable })
  }

  async pull(): Promise<void> {
    const items = await fetchItems()
    runInAction(() => {
      this.items = items
    })
  }
}
