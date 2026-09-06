// Every clone here MUST be reported by `json-roundtrip-tsx`.
// The .ts arm (`json-roundtrip`) does NOT see this file.
export const Card = ({ draft }: Props) => {
  const snapshot = JSON.parse(JSON.stringify(draft))
  return <pre>{snapshot.title}</pre>
}

export const clone = (x: Draft) => JSON.parse(JSON.stringify(x))
