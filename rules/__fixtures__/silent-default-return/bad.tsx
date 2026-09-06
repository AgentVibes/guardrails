// Every return here MUST be reported by `silent-default-return-tsx`.
// The .ts arm (`silent-default-return`) does NOT see this file.
export const A = (x?: T) => { if (!x) return null; return <Use v={x} /> }
export const b = (x?: T[]) => { if (!x) return []; return x }
export const c = (x?: number) => { if (!x) return 0; return x }
export const d = (x?: string) => { if (!x) return ""; return x }
export const E = (x?: T) => { if (x === undefined) return null; return <Use v={x} /> }
export const f = (x?: T[]) => { if (x === undefined) return []; return x }
export const G = (x?: T) => { if (x == null) return null; return <Use v={x} /> }
export const h = (x?: T[]) => { if (x == null) return []; return x }
