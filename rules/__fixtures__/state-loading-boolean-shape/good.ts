// NOTHING in this file may be reported by `state-loading-boolean-shape`.

// The fix: one discriminant, payload only in the branch that has one.
export type Resource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string }

// Independent axes done RIGHT — this is SWR, not boolean soup: "has data" and
// "a fetch is in flight" genuinely are orthogonal (report §14).
export type QueryState<T> =
  | { status: "pending"; fetchActivity: "idle" | "fetching" }
  | { status: "success"; data: T; fetchActivity: "idle" | "fetching" }
  | { status: "error"; error: string; fetchActivity: "idle" | "fetching" }

// A LONE loading flag on a presentational component's props. One boolean
// describing one thing, no payload, no second outcome field — there is no
// invalid state to make unrepresentable. 71 raw `loading: boolean` sites exist
// park-wide and most look like this; flagging them would be noise.
export interface LoadMoreButtonProps {
  loading?: boolean
  onPress: () => void
  label: string
}

export interface InfiniteScrollProps {
  loading?: boolean
  hasMore: boolean
  onLoadMore: () => void
}

// A payload with no loading flag at all.
export interface UserResponse {
  data?: User
  error?: string
}

// Booleans that are not about async outcome.
export interface EditorFlags {
  loading: boolean
  readOnly: boolean
  wrapLines: boolean
}
