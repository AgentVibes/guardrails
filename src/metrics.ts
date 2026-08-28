// `guardrails metrics` — skeleton on purpose. The metrics/ratchet layer
// (component_loc, hook density, context-cost, p90 baselines — spec §5 layer E)
// is a sibling issue; this subcommand exists so callers can already discover
// it and script against its exit contract.
//
// Exit 3 = "subcommand exists, implementation not shipped" — distinct from
// 1 (findings) and 2 (usage/tool error) so harnesses can tell them apart.

export const METRICS_NOT_IMPLEMENTED_EXIT = 3;

export function runMetrics(json: boolean): number {
  const message =
    "guardrails metrics is not implemented yet — the metrics/ratchet layer ships as its own issue (spec layer E). This exit code (3) is the contract, not an error in your setup.";
  if (json) {
    console.log(
      JSON.stringify(
        { command: "metrics", implemented: false, exitCode: METRICS_NOT_IMPLEMENTED_EXIT, message },
        null,
        2,
      ),
    );
  }
  console.error(`warning: ${message}`);
  return METRICS_NOT_IMPLEMENTED_EXIT;
}
