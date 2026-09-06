// Every type here MUST be reported by `literal-union-in-component-tsx`.
// Path matters: the rule is scoped to component/screen/app directories.
//
// This is the file the rule was named for and never saw. Under
// `language: typescript` the `**/components/**/*.tsx` glob in the rule could
// not match anything — the `.tsx` arm makes those glob lines real.

// Enum-style UI state redeclared in the file that renders it.
export type Tab = "tasks" | "habits" | "stream"
export type LoadPhase = "idle" | "loading" | "ready" | "error"
type Align = "start" | "center" | "end"
export type Tone = "neutral" | "danger" | "success" | "warning"

export const TabBar = ({ tab, align }: { tab: Tab; align: Align }) => (
  <nav data-align={align}>{tab}</nav>
)
