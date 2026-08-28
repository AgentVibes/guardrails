// Every getter here MUST be reported by `store-delegation-getter`.
import { makeAutoObservable } from "mobx"

export class AppStore {
  constructor(
    public userStore: UserStore,
    public connectionStore: ConnectionStore,
  ) {
    makeAutoObservable(this)
  }

  // A second name for someone else's field.
  get userName(): string {
    return this.userStore.name
  }

  get userId(): string {
    return this.userStore.id
  }

  // The real shape found in the park (2 sites, metro/byok survey).
  get isConnected(): boolean {
    return this.connectionStore.isConnected
  }

  // Single-expression body, same defect.
  get retryCount(): number {
    return this.connectionStore.retries
  }
}
