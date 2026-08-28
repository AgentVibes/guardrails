// Every async method here MUST be reported by `store-async-method`.
import { makeAutoObservable } from "mobx"

export class ProjectStore {
  projects: string[] = []
  current: string | null = null

  constructor() {
    makeAutoObservable(this)
  }

  // The action ends at the await; the assignment after it is unbatched.
  async load(): Promise<void> {
    const list = await fetchProjects()
    this.projects = list
  }

  // Two awaits, two holes.
  async open(id: string): Promise<void> {
    this.current = await resolveId(id)
    this.projects = await fetchProjects()
  }

  private async refreshQuietly(): Promise<void> {
    this.projects = await fetchProjects()
  }
}

export class SessionStore {
  token = ""
  constructor() {
    makeObservable(this, { token: observable })
  }
  async authenticate(): Promise<void> {
    this.token = await getToken()
  }
}
