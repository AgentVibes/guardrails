// NOTHING in this file may be reported by `non-exhaustive-match`.
import { match } from "ts-pattern"

export const a = (r: R) =>
  match(r)
    .with({ kind: "idle" }, () => 0)
    .with({ kind: "ready" }, () => 1)
    .exhaustive()

// REMOVED BY THE WAVE-2 UPGRADE: the old body was a bare `$X.otherwise($$$)`
// pattern, so any method called `otherwise` on any object was a finding. The
// rule now anchors to a ts-pattern `match()` chain.
export const q = someBuilder.otherwise(() => 1)
export const r = config.fallback.otherwise
