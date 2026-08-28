// NOTHING in this file may be reported by `literal-union-in-component`.

// The fix: consume the shared type, do not restate it.
import type { Tab } from "../../stores/uiStore"
import type { Tone } from "../../lib/tone"

export interface TabBarProps {
  tab: Tab
  tone: Tone
}

// A single-member alias is not an enum-style union.
export type Only = "one"

// A union of non-literals is a different thing entirely.
export type Id = string | number
export type Handler = (() => void) | undefined

// A discriminated union of OBJECT shapes is the pattern this codebase wants
// everywhere — it is not a bare string enum and must not be flagged.
export type Resource<T> =
  | { status: "idle" }
  | { status: "ready"; data: T }
