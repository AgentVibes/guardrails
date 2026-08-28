// Every cast here MUST be reported by `as-any-escape`.
export const a = payload as any
export const b = payload as unknown as User
// ADDED BY THE WAVE-2 UPGRADE: a surface `pattern:` is compared at `smart`
// strictness, which also compares interleaved comment nodes, so this slipped
// straight through the old body.
export const c = payload as /* legacy shim */ any
export const d = payload as /* boundary */ unknown as User
