// NOTHING in this file may be reported by `instanceof-map-set`.
// The fix: a structural check that survives a realm boundary (iframe, worker,
// vm context), where `instanceof` silently returns false.
export const isMapLike = (v: unknown): v is Map<unknown, unknown> =>
  typeof v === "object" && v !== null && typeof (v as Map<unknown, unknown>).get === "function"

export const a = (v: unknown) => v instanceof Date
export const b = (v: unknown) => v instanceof Error
