// NOTHING in this file may be reported by `non-exhaustive-match-tsx`.
import { match } from "ts-pattern"

export const A = (r: R) =>
  match(r)
    .with({ kind: "idle" }, () => <Spinner />)
    .with({ kind: "ready" }, () => <List />)
    .exhaustive()

// The false-positive pins carried over from good.ts: the rule anchors to a
// ts-pattern `match()` chain, so a method merely NAMED `otherwise` is not a
// finding. A revert to the old bare `$X.otherwise($$$)` body fails here.
export const q = someBuilder.otherwise(() => 1)
export const r = config.fallback.otherwise
