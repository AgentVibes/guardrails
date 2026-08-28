// NOTHING in this file may be reported by `ts-pattern-dangling-match`.
import { match } from "ts-pattern"

export function label(r: Resource<string>): string {
  return match(r)
    .with({ kind: "idle" }, () => "idle")
    .with({ kind: "ready" }, ({ value }) => value)
    .exhaustive()
}

// `.otherwise()` and `.run()` terminate a chain too. Whether `.exhaustive()`
// should be PREFERRED over `.otherwise()` is a separate question the owner has
// deferred (decision #4); this rule is only about a chain that ends nowhere.
export function label2(r: Resource<string>): string {
  return match(r).with({ kind: "idle" }, () => "idle").otherwise(() => "?")
}

export function label4(r: Resource<string>): string {
  return match(r).with({ kind: "idle" }, () => "idle").run()
}

// Per-arm comments are why the terminator is matched structurally rather than
// with a surface pattern: `smart` strictness compares comment nodes too.
export function label5(r: Resource<string>): string {
  return match(r)
    // the boring case
    .with({ kind: "idle" }, () => "idle")
    // the interesting one
    .with({ kind: "ready" }, ({ value }) => value)
    .exhaustive()
}

// String.prototype.match is not ts-pattern and must never be confused for it.
export const m = "abc".match(/b/)
export const m2 = someText.match(pattern)?.[0]
