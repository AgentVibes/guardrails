// NOTHING in this file may be reported by `discriminator-ternary-ts`.
import { match } from "ts-pattern"

// The fix: match the value, so a new variant is a build error.
export const first = (m: Maybe<string[]>) =>
  match(m)
    .with({ kind: "some" }, ({ value }) => value)
    .with({ kind: "none" }, () => [])
    .exhaustive()

// Not a discriminator field.
export const n = (u: U) => (u.count === 0 ? "none" : "some")
export const s = (u: U) => (u.name === "root" ? 1 : 2)

// Not an equality test on a discriminator.
export const t = (u: U) => (u.ready ? "y" : "n")
export const v = (u: U) => (u.items.length > 3 ? "many" : "few")
