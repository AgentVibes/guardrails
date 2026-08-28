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

## CI gate (reusable workflow)

Add the whole gate as one job:

```yaml
jobs:
  guardrails:
    uses: AgentVibes/guardrails/.github/workflows/guardrails-gate.yml@v0
    # with:
    #   leaks: true        # recommended for public repos
    #   base: origin/main  # override the merge-base ladder
```

It checks out with full history, installs the pinned toolchain via mise, runs
`pnpm install --frozen-lockfile`, then BLOCKING `guardrails verify-diff` and
`guardrails metrics --check` (skipped with a loud `::notice::` when the repo
has no `.guardrails/metrics.json` baseline — never silently). `@v0` is a
moving tag that follows validated releases, actions-style; pin `@<commit-sha>`
if your repo wants immutable supply-chain refs.

**Mandatory adoption step — prove the gate can fail.** After wiring the job,
open a throwaway PR containing an error-tier violation and watch it go red:

```sh
git checkout -b gate-red-team
printf 'export const boom = (x: unknown) => x as any;\n' > gateRedTeam.ts
git add gateRedTeam.ts && git commit -m "red-team the guardrails gate" && git push -u origin gate-red-team
# open the PR → the guardrails job MUST fail on as-any-escape.
# Then close the PR and delete the branch.
```

A gate that has never been seen red proves nothing — do not skip this.

## Post-edit hook

`guardrails hook-postedit` is the Claude Code PostToolUse hook: it reads the
hook JSON on stdin, and for an Edit/Write of a .ts/.tsx file scans just that
file, gating the lines the edit actually changed (merge-base ladder; Write,
untracked files, and unresolvable bases degrade to whole-file — never to
silence). Error-tier findings emit a blocking decision, warnings attach as
context. Wire it in settings.json:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write",
  "hooks": [{ "type": "command", "command": "pnpm exec guardrails hook-postedit" }] } ] } }
```

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
- `candidates/` — triaged in wave 2. Three PPA R-rules were promoted into
  `rules/`; the eight that remain are repo-local by decision, with the reason
  for each recorded in `candidates/README.md`. Still loaded nowhere.

## Repo-local extra rules

A rule that encodes ONE repo's convention does not belong in the canon — but it
should still run. `guardrails init` already writes the second `ruleDir`
commented out; uncomment it and drop the rule in:

```yaml
# sgconfig.yml
ruleDirs:
  - node_modules/@agentvibes/guardrails/rules
  - .ast-grep/rules          # repo-local extras
```

Both directories load together and findings print their own rule id, so a local
rule suppresses under its own name. Verified: a canon rule and a repo-local rule
firing side by side in one `ast-grep scan -c sgconfig.yml` run.

Keep local ids distinct from canon ids — ast-grep refuses to load two rules with
the same id, and a repo-local override of a canon rule is a silent fork rather
than a fix. If a local rule turns out to be generally useful, promote it here
with fixtures instead of copying it into a second repo.

## Development

`pnpm check` = build (tsc) + biome + fixture harness + gate-can-go-red test.
CI runs exactly that, blocking.
