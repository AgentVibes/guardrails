# @agentvibes/guardrails

Verification toolkit that makes agents write simple code. One package holds the
canonical ast-grep rule set (moved here from the agent-skills `defensive-errors`
skill — this repo is now the source of truth; the skill and hooks consume
builds of this package), the react structure check, an added-lines diff
ratchet, and the shared biome/tsconfig presets.

## Install

```sh
pnpm add -D @agentvibes/guardrails
```

Tools (ast-grep, biome) are not npm dependencies: the CLI resolves them from
PATH, falls back to `mise x <tool>@<pin>` using the pins in this package's
`mise.toml`, and prints a one-line install hint when neither works.

Installing straight from git (`github:AgentVibes/guardrails#<sha>`) works —
the `prepare` script builds `dist/` at install time — but pnpm blocks
lifecycle scripts of git-hosted deps by default: add an `allowBuilds` entry
for the exact resolved spec to the consuming repo's `pnpm-workspace.yaml`
(`"@agentvibes/guardrails@github:AgentVibes/guardrails#<sha>": true`), or
install from the registry once the package is published.

## Commands

All subcommands accept `--json`.

| command | what | exit |
|---|---|---|
| `guardrails verify [paths]` | full scan: rule canon + text-greps + structure (one component per file, 120-line error / 90-line warning) | 1 on any error-tier finding |
| `guardrails verify-diff [--base R]` | ratchet: error-tier findings on lines your diff ADDED vs merge-base; falls back to whole-file, then whole-tree — never to silence | 1 on new findings only |
| `guardrails doctor` | tool versions + resolution route, ruleset SHA, config discovery | 1 if a tool is missing |
| `guardrails init` | writes `sgconfig.yml`, `biome.json` (extends the preset), and a detected-and-materialized `[stack]` in `.agentvibes/project.toml` | 0 |
| `guardrails metrics [paths]` | per-component (loc, hooks, props, observer, JSX depth, branching), per-file (sloc, context-cost) and per-project metrics; `--check` compares the GATED set against the committed `.guardrails/metrics.json` baseline (recomputes facts, never trusts the file); `--update-baseline` tightens it (2% hysteresis, never loosens without `--force`); `--snapshot` appends a JSONL trend row | 1 on ratchet regression, 2 when `--check` finds no baseline |

Gated (ratchet, lower = better): p90 component_loc, useState density,
inline-map-row count, p90 context-cost, runInAction count, async-in-store,
new-Map-in-store, reactions total, loading-boolean shapes. Everything else is
observe-only.

Counter provenance: runInAction / async-in-store / new-Map-in-store /
inline-map-row are finding counts of the canon rules (`store-no-runinaction`,
`store-async-method`, `store-new-map`, `inline-map-row` + tsx twins) — the
metric counts exactly what `verify` gates. Note the rules' scoping:
"store" means a class calling `make(Auto)Observable` (not a name/path
heuristic), and `async_in_store` counts only async methods that mutate `this`
WITHOUT a `runInAction` patch — the patched ones are already in
`runInAction_count`, so the two counters partition the should-be-`flow()`
population without double counting. `reactions_total` is a direct AST
count (no rule yet). `loading_boolean_shapes` is deliberately NOT the
`state-loading-boolean-shape` rule: the rule fires only on type-level shapes
where the outcome is recorded twice (loading flag + second outcome/payload
field), while the metric also counts lone boolean progress-flag declarations
(`loading = false` class fields) — the wider Resource<T> migration target.

## Leak gate

`guardrails leaks [paths]` is the public/private boundary gate: it scans every
text file for credential patterns, runs gitleaks when available, and exits 1
on any hit. The package ships only generic credential shapes; house marker
lists ship via private plugins/config — `.guardrails/leaks.txt`, a
`[leaks] patterns_file =` manifest entry, or the plugin contract's
`leakPatterns()` hook (see `@agentvibes/guardrails/plugin`). Pattern files are
one regex per line (`<id> <regex>`, `#` comments) and are themselves exempt
from the scan. This repo runs the gate against itself in `pnpm check` and CI.

## Deploy plugins

`guardrails deploy [args…]` is an extension point, not a deployer: the public
CLI resolves a plugin — `plugin = "<npm name>"` under `[deploy]` in
`.agentvibes/project.toml`, or a single `guardrails-plugin-*` dependency — and
hands it the args plus the `[deploy]` table. A plugin exports (default or
named `plugin`) an object `{ name, deploy(args, context) }`; the contract type
ships as `@agentvibes/guardrails/plugin`. All topology facts (hosts, orgs,
registries, SSO) live in private plugin packages; `guardrails leaks` enforces
that this package contains none.

## Presets

```jsonc
// biome.json
{ "extends": ["@agentvibes/guardrails/biome"] }
// tsconfig.json
{ "extends": "@agentvibes/guardrails/tsconfig" }
```

## Rules and fixtures

- `rules/` — the canon. Stable ids, each message is a mini-manual (why + fix).
  Suppress a genuine false positive with
  `// ast-grep-ignore: <rule-id> -- <why>` on the line above.
- `rules/__fixtures__/` — bad/good fixture pairs; `pnpm test:rules` asserts
  exact hit counts in both directions (a rule that fails to load fails the
  test — silence is not a pass).
- `structure/` — the `component-decl` marker rule the CLI turns into
  `react-multi-component` / `react-component-too-long` /
  `react-component-needs-folder` findings.
- `candidates/` — un-triaged imports (PPA R-rules); loaded nowhere.

## Development

`pnpm check` = build (tsc) + biome + fixture harness + gate-can-go-red test.
CI runs exactly that, blocking.
