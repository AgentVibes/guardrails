// NOTHING in this file may be reported by `discriminator-ternary`.
import { match } from "ts-pattern"

// The fix: match the value, so a new variant is a build error.
export const first = (m: Maybe<string[]>) =>
  match(m)
    .with({ kind: "some" }, ({ value }) => value)
    .with({ kind: "none" }, () => [])
    .exhaustive()

// A ternary whose branches are JSX belongs to `jsx-ternary`, which owns that
// case with the same fix. This rule stands down so the two can never report the
// same line twice — measured overlap on tg-gallery + observatory: 0.
export const View = (r: R) => (r.status === "error" ? <ErrorState /> : <Ready />)
export const View2 = (r: R) => (r.kind === "idle" ? null : <Spinner />)

// Not a discriminator field.
export const n = (u: U) => (u.count === 0 ? "none" : "some")
export const s = (u: U) => (u.name === "root" ? 1 : 2)

// Not an equality test on a discriminator.
export const t = (u: U) => (u.ready ? "y" : "n")
export const v = (u: U) => (u.items.length > 3 ? "many" : "few")
