// Every match chain here MUST be reported by `ts-pattern-dangling-match`.
import { match } from "ts-pattern"

// A real observatory chain with its terminator deleted: evaluates to a builder
// object, which is truthy, so the caller keeps compiling and every arm is dead.
export function label(r: Resource<string>): string {
  return match(r)
    .with({ kind: "idle" }, () => "idle")
    .with({ kind: "ready" }, ({ value }) => value)
}

// The hard case: a dangling chain nested inside a callback of an OUTER
// terminated chain. The spine-walk must not let the outer terminator mask it.
export function label3(r: Resource<Item[]>): string {
  return match(r)
    .with({ kind: "ready" }, ({ value }) =>
      value.map((it) => match(it).with({ t: "a" }, () => "A")).join(","),
    )
    .otherwise(() => "")
}
