// Every clone here MUST be reported by `json-roundtrip`.
export const a = (x: Draft) => JSON.parse(JSON.stringify(x))
export const b = (x: Draft) => {
  const copy = JSON.parse(JSON.stringify(x))
  return copy
}
