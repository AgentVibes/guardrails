// Every type here MUST be reported by `state-loading-boolean-shape`.

// The canonical boolean soup: loading + optional payload + optional error.
export interface FetchState {
  loading: boolean
  data?: User[]
  error?: string
}

// Multi-flag, no payload — the shape gallerykit's ImageLoadState really has.
export interface ImageLoadState {
  isLoading: boolean
  isLoaded: boolean
  isError: boolean
  error: Event | null
}

// Null-union rather than optional; same set of impossible states.
export interface AdapterState {
  loading: boolean
  data: Rows | null
  error: string | null
}

// A type alias rather than an interface.
export type PlaygroundState = {
  isFetching: boolean
  result?: QueryResult
  error?: string
}

// `pending` is the same axis under another name.
export interface SaveState {
  pending: boolean
  succeeded: boolean
}
