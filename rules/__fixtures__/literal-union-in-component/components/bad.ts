// Every type here MUST be reported by `literal-union-in-component`.
// Path matters: the rule is scoped to component/screen/app directories.

// Enum-style UI state redeclared in the file that renders it.
export type Tab = "tasks" | "habits" | "stream"
export type LoadPhase = "idle" | "loading" | "ready" | "error"
type Align = "start" | "center" | "end"
export type Tone = "neutral" | "danger" | "success" | "warning"
