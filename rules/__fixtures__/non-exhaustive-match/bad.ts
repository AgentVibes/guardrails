// Every chain here MUST be reported by `non-exhaustive-match`.
import { match } from "ts-pattern"
export const a = (r: R) => match(r).with({ kind: "idle" }, () => 0).otherwise(() => -1)
export const b = (r: R) =>
  match(r)
    .with({ kind: "idle" }, () => 0)
    .with({ kind: "ready" }, () => 1)
    .otherwise(() => -1)
