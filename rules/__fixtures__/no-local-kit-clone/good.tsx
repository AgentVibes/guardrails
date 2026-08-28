// NOTHING in this file may be reported by `no-local-kit-clone`.

// The fix: import, do not redeclare.
import { warnDegraded, warnNotImplemented } from "@agentvibes/kit/diagnostics"
import { usePageStore } from "@agentvibes/kit/react"
import type { QueryState, Resource } from "@agentvibes/kit/resource"

// An unrelated domain type that happens to be called Resource. Real: the
// VolumePhotography conferences page. No type parameters, no async state — the
// type-parameter requirement is what keeps this out.
interface Resource {
  name: string
  url: string
  type: string
  description: string
}

const conferences: Resource[] = []

// Re-exporting the kit's types is not redeclaring them.
export type { QueryState, Resource }
export { usePageStore, warnDegraded, warnNotImplemented }

// A local helper with a name of its own.
export function warnStale(context: string): void {
  warnDegraded(context, "cache is stale")
}

// A differently-named local async union is out of this rule's scope; it is
// `state-loading-boolean-shape` and the Resource migration that speak to it.
export type LoadPhase = { status: "idle" } | { status: "busy" }
