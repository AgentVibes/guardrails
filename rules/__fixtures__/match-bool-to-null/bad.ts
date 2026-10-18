// Every match here MUST be reported by `match-bool-to-null-ts`.
import { match } from "ts-pattern"

export const badge = (on: boolean) =>
  match(on)
    .with(true, () => "new")
    .with(false, () => null)
    .exhaustive()

export const hint = (ready: boolean, text: string) =>
  match(ready)
    .with(true, () => text.toUpperCase())
    .with(false, () => null)
    .exhaustive()
