// Every pair here MUST be reported by `demo-mode-by-default`.
// The rule is scoped to the positions that decide what the app STARTS on:
// an initialState-family function, a DEFAULT_/INITIAL_ binding, or the initial
// argument of useState/useReducer.

// The annotated form, which the rule caught from the start.
export const DEFAULT_MODE: Mode = { kind: "demo" }

// The `as const` form (is-9e66ec5a). This is the spelling people reach for
// when the object carries no type annotation to hold the literal type, and it
// was silently missed — DataSpool's retired local `no-fake-defaults` caught it,
// so adopting the canon had been a coverage regression.
export const DEFAULT_STATE = { mode: "demo" as const }

// `as <Type>` and `satisfies <Type>`, the same wrapper wearing other names.
export const DEFAULT_BACKEND = { source: "fixture" as Backend }
export const INITIAL_MODE = { kind: "mock" satisfies Mode }

// Inside an initialState-family function rather than a binding.
export function initialState() {
  return { mode: "demo" as const }
}
