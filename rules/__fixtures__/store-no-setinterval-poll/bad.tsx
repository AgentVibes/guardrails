// Every setInterval call here MUST be reported by `store-no-setinterval-poll`.
import { makeAutoObservable } from "mobx"

export class LiveDataStore {
  rows: Row[] = []
  private timer: ReturnType<typeof setInterval> | undefined

  constructor() {
    makeAutoObservable(this)
  }

  start(): void {
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  startSynthetic(sink: Sink): void {
    setInterval(() => sink.onRow(this.emitSyntheticRow()), SSE_TICK_MS)
  }
}
