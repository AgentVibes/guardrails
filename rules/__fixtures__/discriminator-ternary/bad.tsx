// Every ternary here MUST be reported by `discriminator-ternary`.

// The terse option-unwrap the PPA audit found 18 of.
export const first = (m: Maybe<string[]>) => (m.kind === "some" ? m.value : [])
export const adapter = (s: S) => (s.adapter.kind === "some" ? s.adapter.value : "—")
// Other discriminator names the rule covers.
export const label = (r: R) => (r.status === "error" ? "Bad" : "Ok")
export const port = (c: C) => (c.type === "tcp" ? c.port : 0)
export const key = (p: P) => (p.provider === "openai" ? p.apiKey : p.token)
export const tone = (n: N) => (n.mode !== "dark" ? "light" : "dark")
