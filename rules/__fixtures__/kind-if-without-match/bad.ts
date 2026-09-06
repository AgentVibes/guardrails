// Every `if` here MUST be reported by `kind-if-without-match`.
export const a = (r: R) => {
  if (r.kind === "idle") return 0
  return 1
}
export const b = (r: R) => {
  if (r.type === "photo") return 0
  return 1
}
export const c = (r: R) => {
  if (r.status === "ready") return 0
  return 1
}
export const d = (r: R) => {
  if (r._obj === "Task") return 0
  return 1
}
