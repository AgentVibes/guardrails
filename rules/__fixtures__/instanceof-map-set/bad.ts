// Every check here MUST be reported by `instanceof-map-set`.
export const a = (v: unknown) => v instanceof Map
export const b = (v: unknown) => v instanceof Set
// ADDED BY THE WAVE-2 UPGRADE: the old body named only Map and Set, and these
// two have exactly the same cross-realm failure.
export const c = (v: unknown) => v instanceof WeakMap
export const d = (v: unknown) => v instanceof WeakSet
