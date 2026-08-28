// Every field here MUST be reported by `store-new-map`.
import { makeAutoObservable } from "mobx"

export class GalleryStore {
  // Observable field, non-observable contents: .set() notifies nobody.
  entries = new Map<string, Row>()
  byId = new Map()

  constructor() {
    makeAutoObservable(this)
  }
}

export class CalendarStore {
  // Annotated, but this field is not the one exempted.
  monthCache = new Map<string, Day[]>()
  private _other = new Map<string, number>()

  constructor() {
    makeAutoObservable(this, { somethingElse: false })
  }
}
