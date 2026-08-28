// NOTHING in this file may be reported by `store-no-setinterval-poll`.
import { makeAutoObservable } from "mobx"

export class LiveDataStore {
  rows: Row[] = []

  // A TYPE position, not a call. The commonest way `setInterval` appears in a
  // store field declaration, and it must stay silent.
  private timer: ReturnType<typeof setInterval> | undefined

  constructor() {
    makeAutoObservable(this)
  }

  // The fix: the Query object owns the disposer, the in-flight dedup and the
  // visibility handling.
  readonly rowsQuery = new Query(() => fetchRows(), { refetchInterval: POLL_MS })

  stop(): void {
    clearInterval(this.timer)
  }
}

// Not a store: a plain scheduler class.
export class Ticker {
  start(): void {
    setInterval(() => this.tick(), 1000)
  }
}
