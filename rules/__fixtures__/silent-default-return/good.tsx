// NOTHING in this file may be reported by `silent-default-return-tsx`.
export const A = (x?: T) => {
  if (!x) throw new Error("A(): x is required; the caller rendered it with nothing")
  return <Use v={x} />
}

// Rendering an explicit empty state is not a silent default.
export const B = (x?: T) => {
  if (!x) return <Empty reason="no-x" />
  return <Use v={x} />
}
