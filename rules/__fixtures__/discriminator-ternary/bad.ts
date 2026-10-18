// Every ternary here MUST be reported by `discriminator-ternary-ts`.
// Same cases as bad.tsx: none of them needs JSX, so a `.ts` file holds them too.

export const first = (m: Maybe<string[]>) => (m.kind === "some" ? m.value : [])
export const adapter = (s: S) => (s.adapter.kind === "some" ? s.adapter.value : "—")
export const label = (r: R) => (r.status === "error" ? "Bad" : "Ok")
export const port = (c: C) => (c.type === "tcp" ? c.port : 0)
export const key = (p: P) => (p.provider === "openai" ? p.apiKey : p.token)
export const tone = (n: N) => (n.mode !== "dark" ? "light" : "dark")
