// NOTHING in this file may be reported by `kind-if-without-match`.
import { match } from "ts-pattern"

export const a = (r: R) =>
  match(r)
    .with({ kind: "idle" }, () => 0)
    .with({ kind: "ready" }, () => 1)
    .exhaustive()

// Not a discriminant field, so not this rule's business.
export const b = (r: R) => {
  if (r.count === 0) return 0
  return 1
}
