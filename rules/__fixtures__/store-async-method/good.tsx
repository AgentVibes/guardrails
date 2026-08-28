// NOTHING in this file may be reported by `store-async-method`.
import { flow, makeAutoObservable, runInAction } from "mobx"

export class ProjectStore {
  projects: string[] = []

  constructor() {
    makeAutoObservable(this)
  }

  // The fix: a flow resumes inside an action at every yield.
  load = flow(function* (this: ProjectStore) {
    this.projects = yield fetchProjects()
  })

  // Already reported by `store-no-runinaction` at error tier, and the fix is
  // the same conversion. Reporting it twice would read as two problems, so this
  // rule stands down when runInAction is present.
  async loadLegacy(): Promise<void> {
    const list = await fetchProjects()
    runInAction(() => {
      this.projects = list
    })
  }

  // Not async.
  reset(): void {
    this.projects = []
  }
}

// A plain class with no MobX annotation is not a store; async methods on it
// have no action semantics to lose.
export class ApiClient {
  async get(url: string): Promise<Response> {
    return fetch(url)
  }
}

// ── the false-positive class this rule was narrowed to exclude ─────────
// Private async helpers that do pure I/O and never touch an observable field.
// There is no action coverage to lose, so there is nothing to convert. Real:
// SiteCraft's walkDir / collectAllFiles / uploadFile — 10 of the rule's 12
// hits in that repo before the mutation requirement was added.
export class ContentStore {
  files: string[] = []

  constructor() {
    makeAutoObservable(this)
  }

  private async walkDir(fs: FileSystem, dir: string, items: Meta[]): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const e of entries) items.push(await fs.stat(e))
  }

  private async collectAllFiles(fs: FileSystem, dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    await this.walkFs(fs, dir, result)
    return result
  }

  async uploadFile(targetDir: string, name: string, data: Uint8Array): Promise<string> {
    const path = `${targetDir}/${name}`
    await this.fs.writeFile(path, data)
    return path
  }
}
