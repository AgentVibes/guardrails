// Every call here MUST be reported by `zod-optional-nullable`.
import { z } from "zod"
export const A = z.object({ name: z.string().optional() })
export const B = z.object({ age: z.number().nullable() })
export const C = z.object({ bio: z.string().nullish() })
// ADDED BY THE WAVE-2 UPGRADE: the old `z.$T().optional()` matched only a
// DIRECT call on `z`, so a chained builder and a named schema both escaped.
export const D = z.object({ name: z.string().min(1).optional() })
export const E = UserSchema.optional()
export const F = z.object({ tag: z.enum(["a", "b"]).trim().nullable() })
