// Every declaration here MUST be reported by `no-local-kit-clone`.

// 7 of these exist across the park, discriminated by `kind` in three repos,
// `status` in two and `state` in one.
export type Resource<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string }

export type QueryState<T> =
  | { status: "pending" }
  | { status: "success"; data: T }

export class ObservableQuery<T> {
  constructor(private readonly fetcher: () => Promise<T>) {}
}

// gramforge carries six byte-identical copies of these two inside one monorepo.
export function warnDegraded(context: string, detail: string): void {
  console.warn(`[degraded] ${context}: ${detail}`)
}

export function warnNotImplemented(category: string, detail: string): void {
  console.warn(`[not-implemented] ${category}: ${detail}`)
}

// The useMemo improvisation with no dispose that report §8 found everywhere.
export const usePageStore = <T>(factory: () => T, deps: unknown[]): T => {
  return useMemo(factory, deps)
}
