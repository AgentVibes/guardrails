// NOTHING in this file may be reported by `kind-if-without-match-tsx`.
import { match } from "ts-pattern"

export const A = (r: R) =>
  match(r)
    .with({ kind: "idle" }, () => <Spinner />)
    .with({ kind: "ready" }, () => <List />)
    .exhaustive()

export const B = (r: R) => {
  if (r.count === 0) return <Empty />
  return <List />
}
