// Every chain here MUST be reported by `non-exhaustive-match-tsx`.
// The .ts arm (`non-exhaustive-match`) does NOT see this file: ast-grep's
// `typescript` and `tsx` languages are disjoint.
import { match } from "ts-pattern"

export const A = (r: R) => match(r).with({ kind: "idle" }, () => <Spinner />).otherwise(() => null)

export const B = (r: R) =>
  match(r)
    .with({ kind: "idle" }, () => <Spinner />)
    .with({ kind: "ready" }, () => <List />)
    .otherwise(() => <Empty />)
