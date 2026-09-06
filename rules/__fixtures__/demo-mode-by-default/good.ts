// NOTHING in this file may be reported by `demo-mode-by-default-ts`.

// The real source as the default is the whole point of the rule.
export const DEFAULT_MODE = { kind: "live" as const }
export const DEFAULT_BACKEND: Backend = { source: "api" }

// A demo literal in a `.with(...)` match arm is the CORRECT pattern — an
// explicit flag selecting the sandbox — and is excluded by design.
export const pick = (flag: Flag) =>
  match(flag)
    .with("sandbox", () => ({ kind: "demo" as const }))
    .with("real", () => ({ kind: "live" as const }))
    .exhaustive()

// Not a start-up position: an ordinary binding the rule deliberately ignores,
// so the scope stays narrow rather than flagging every mention of a fixture.
export const sampleRow = { kind: "demo" as const }

// The quote characters are part of the match, so a longer string that merely
// STARTS with a banned word is not a finding.
export const DEFAULT_STATE = { kind: "demo-recording" as const }
