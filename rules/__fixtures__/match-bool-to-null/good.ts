// NOTHING in this file may be reported by `match-bool-to-null-ts`.
import { match } from "ts-pattern"

// Both arms produce a value: match() is the right tool.
export const label = (on: boolean) =>
  match(on)
    .with(true, () => "on")
    .with(false, () => "off")
    .exhaustive()

// A plain conditional for "maybe this value".
export const badge = (on: boolean) => (on ? "new" : null)
