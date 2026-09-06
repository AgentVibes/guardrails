// NOTHING in this file may be reported by `silent-default-return`.
export const a = (x?: T) => {
  if (!x) throw new Error("a(): x is required; caller passed nothing")
  return use(x)
}

// An explicit discriminated failure variant is the sanctioned shape.
export const b = (x?: T) => {
  if (!x) return { kind: "failure", reason: "missing-x" } as const
  return { kind: "success", value: use(x) } as const
}

// The rule is the SILENT default, not every early return.
export const c = (x?: T) => {
  if (!x) return fallbackFor(x)
  return use(x)
}
