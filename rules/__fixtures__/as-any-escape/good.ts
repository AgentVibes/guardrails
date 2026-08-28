// NOTHING in this file may be reported by `as-any-escape`.
import { UserSchema } from "./schema"

// The fix: validate at the boundary.
export const a = UserSchema.parse(payload)

// Widening to `unknown` alone is fine — it FORCES the caller to narrow, which
// is the behaviour we want. Only the double-cast that lands back on a concrete
// type is an escape hatch.
export const b = payload as unknown

// Ordinary, checked casts.
export const c = "idle" as const
export const d = value as never
