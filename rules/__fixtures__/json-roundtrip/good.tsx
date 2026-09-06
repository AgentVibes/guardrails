// NOTHING in this file may be reported by `json-roundtrip-tsx`.
export const Card = ({ raw }: Props) => {
  const draft = DraftSchema.parse(JSON.parse(raw))
  return <pre>{draft.title}</pre>
}

export const clone = (x: Draft) => structuredClone(x)
