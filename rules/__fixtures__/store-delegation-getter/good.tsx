// NOTHING in this file may be reported by `store-delegation-getter`.
import { makeAutoObservable } from "mobx"

// ── The data-wrapper pattern: 89 of the 91 single-line `return this.X.y`
// getters measured across byok, metro, SiteCraft and observatory look exactly
// like this. A model holding a plain record and republishing its fields as
// observable getters is the sanctioned shape (byok packages/shared/src/models/
// model.ts, metro apps/web-pmetro/src/stores/domain/station.store.ts).
export class Model {
  readonly data: ModelRecordData

  constructor(data: ModelRecordData) {
    this.data = data
    makeAutoObservable(this, { data: false })
  }

  get id(): string {
    return this.data.id
  }
  get slug(): string {
    return this.data.slug
  }
  get name(): string {
    return this.data.name
  }
  get backend(): ModelBackend {
    return this.data.backend
  }
}

export class AppStore {
  constructor(public userStore: UserStore) {
    makeAutoObservable(this)
  }

  // A real derivation — combines, formats, decides. This is what computeds are
  // for and it is not an alias.
  get greeting(): string {
    return `Hello, ${this.userStore.name}!`
  }

  get hasName(): boolean {
    return this.userStore.name.length > 0
  }

  // Computed on the way out, so not a bare forward.
  get displayName(): string {
    const raw = this.userStore.name
    return raw.trim() === "" ? "anonymous" : raw
  }

  // Reads its OWN field, not another store's.
  get ready(): boolean {
    return this.loaded
  }

  // KNOWN, DELIBERATE MISS. A rootStore reference conventionally named `root`
  // (WireDrill spells it that way, annotated `{ root: false }`) is a genuine
  // store-to-store alias that this rule does not catch — the name test keys on
  // a `Store` suffix, and widening it to `root` starts pulling `this.data`-shaped
  // names back into scope. Pinned here so the gap stays a decision.
  get rootUser(): User {
    return this.root.user
  }
}
