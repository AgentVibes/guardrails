// NOTHING in this file may be reported by `zod-optional-nullable`.
import { z } from "zod"

// The fix: model the absence as a variant, so "missing" and "present" are
// distinguishable states rather than one field that might be undefined.
export const User = z.discriminatedUnion("status", [
  z.object({ status: z.literal("anonymous") }),
  z.object({ status: z.literal("named"), name: z.string() }),
])

export const Plain = z.object({ name: z.string(), age: z.number() })

// `.optional()` on something that is not a zod schema — the receiver anchor is
// what keeps an unrelated builder with the same method name out of this rule.
export const q = queryBuilder.optional()
export const p = protoField.nullable()
