// NOTHING in this file may be reported by `json-roundtrip`.
// The rule is the composed round trip, not either half on its own.
export const a = (raw: string) => DraftSchema.parse(JSON.parse(raw))
export const b = (x: Draft) => JSON.stringify(x)
export const c = (x: Draft) => structuredClone(x)
