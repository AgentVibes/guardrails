// Every `if` here MUST be reported by `kind-if-without-match-tsx`.
// The .ts arm (`kind-if-without-match`) does NOT see this file.
export const A = (r: R) => {
  if (r.kind === "idle") return <Spinner />
  return <List />
}
export const B = (r: R) => {
  if (r.type === "photo") return <Photo />
  return <Video />
}
export const C = (r: R) => {
  if (r.status === "ready") return <List />
  return <Spinner />
}
export const D = (r: R) => {
  if (r._obj === "Task") return <Task />
  return <Habit />
}
