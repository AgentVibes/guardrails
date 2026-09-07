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
lifecycle scripts of git-hosted deps by default, and the unblock knob moved
between pnpm versions:

| pnpm | where to allow the build |
|---|---|
| 10.0–10.4 | `package.json` → `pnpm.onlyBuiltDependencies: ["@agentvibes/guardrails"]` |
| 10.5+ | `pnpm-workspace.yaml` → `onlyBuiltDependencies: ["@agentvibes/guardrails"]` |
| 11+ | `pnpm-workspace.yaml` → `allowBuilds` keyed by the exact resolved spec |

(or install from the registry once the package is published).

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
has no `.guardrails/metrics.json` baseline — never silently).

Workspaces that reach outside their repo (`link:../<repo>/...` overrides,
`../../<org>/<repo>` workspace globs) pass
`sibling_repos: "owner/repo owner2/repo2"`: the gate then checks the main
repo out at `repos/<org>/<repo>` depth and shallow-clones each sibling at its
own `repos/<owner>/<name>`, reproducing a `gits/<org>/<repo>` disk layout so
the relative escapes resolve. Private siblings additionally need
`secrets: { sibling_token: <PAT with read on them> }` — the default job token
cannot reach other repos. `@v0` is a
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

## Stop hook

`guardrails hook-stop` is the "cannot say done over red findings" echelon: on
Claude Code's Stop event it runs the verify-diff ratchet over the session's
changed files and blocks the stop while NEW error-tier findings remain. Loop
breaker built in: after 3 blocks in one session (env
`GUARDRAILS_STOP_MAX_BLOCKS`) it stops blocking and prints a loud warning
instead — a wedged agent is worse than undercleaned code, and CI holds the
same line anyway. Like hook-postedit, it never fails the session on its own
defects.

```json
{ "hooks": { "Stop": [ { "hooks": [{ "type": "command",
  "command": "pnpm exec guardrails hook-stop" }] } ] } }
```

For a USER-level install (synced settings.json, per-machine tools), route
both hooks through an opt-hook.sh-style wrapper that no-ops when the tool is
absent on a host — a bare command errors on every event on machines without
the package.

## Iterate harness

`guardrails iterate --task <file|text> --cmd '<runner>'` is the
iterate-until-pass loop for cheap-model campaigns: run the agent command, run
the gate ITSELF (never trusting the agent's report), feed the findings back as
the next prompt's compact feedback, repeat to green or `--max` (default 6;
`--gate` overrides the default `verify-diff`). The runner gets the prompt on
stdin and via `$GUARDRAILS_PROMPT_FILE`, plus `$GUARDRAILS_ATTEMPT`:

```sh
guardrails iterate --task task.md \
  --cmd 'claude -p "$(cat "$GUARDRAILS_PROMPT_FILE")" --model sonnet' \
  --gate 'pnpm exec guardrails verify-diff && pnpm exec guardrails metrics --check'
```

Every attempt's tuple (agent exit, gate exit, gate tail, duration) is recorded
and printed (`--json` for harness pipelines).

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

### One biome config per repo, and it is the preset

The biome preset is a preset, not a starting point. `guardrails verify` and
`guardrails doctor` check the repo for drift and name the offending keys in one
line. Three things count as drift:

| | what | why |
|---|---|---|
| a | `biome.json` does not list `@agentvibes/guardrails/biome` in `extends` | it is not using the preset at all |
| b | it extends the preset and then carries its own `formatter`, `javascript.formatter`, `json.formatter`, `linter` or `assist` | those are the preset's decisions, restated locally so they can drift |
| c | a second `biome.json` / `biome.jsonc` exists in the tree (outside `node_modules`, `dist`, `.claude` and the other skipped dirs) | two configs means two answers |

Two things stay legal, because they scope rather than restyle: `files` (a repo
decides which of ITS paths are linted) and an `overrides` entry that only turns
`suspicious.noConsole` off for some paths (a CLI has to print).

**Enforcement is opt-in per repo, for now.** Add

```toml
# .agentvibes/project.toml
[biome]
preset = "enforced"
```

and `verify` exits 2 on drift, `doctor` exits 1. Without it both still SAY the
drift — `verify` prints it as a note, `doctor` as a `biome preset` line — and
neither changes its exit code. The reason is sequencing, not softness: epic
is-a70a5963 is migrating 37 configs, and 5 of the 7 repos running this gate do
not conform yet. Each migration adds the line as its last step; when the last
one lands, the default flips to enforced.

The reusable gate workflow runs `verify-diff`, not `verify`, so a repo that opts
in should add a `guardrails verify` (or `doctor`) step to its own CI.

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

Per-repo severity RAISE: a repo that held a rule stricter than the canon keeps
its gate via `[severity]` in `.agentvibes/project.toml`
(`zod-optional-nullable = "error"`) — applied through ast-grep's native
`--error=<rule-id>` in verify, verify-diff and the post-edit hook, so no
same-id rule fork is ever needed. Raise-only: downgrades and unknown rule ids
are refused (exit 2); weakening has its own sanctioned homes (warn-tier biome
deviation, `[verify] exclude` for vendored trees, justified per-line
`ast-grep-ignore`).

## Rule twins — one rule, two ids

ast-grep's `typescript` and `tsx` languages are **disjoint, not nested**: a rule
declared `language: typescript` reads `.ts` and never `.tsx`, and vice versa.
There is no way to say "both" — `language: [typescript, tsx]` fails to parse,
`languageGlobs` reassigns `.ts` to the tsx language and blinds every remaining
`typescript` rule (measured corpus-wide: 5 rules dark, 6,094 findings lost
against 334 gained), and two files sharing an id are refused outright.

So a rule that must run on both is **two files with two ids**: `catch-empty.yml`
and `catch-empty-tsx.yml`. The trailing `-tsx` is what you suppress with in a
`.tsx` file, and the finding prints the id, so copying from the output is always
right. A handful of pairs are spelled the other way round — the tsx arm came
first and the `.ts` half is the `-ts` suffix (`demo-mode-by-default` +
`demo-mode-by-default-ts`). Both spellings are one family.

The two arms are one rule wearing two ids, so their `severity`, `files`,
`ignores`, `utils` and `rule` blocks must stay byte-identical; only `id`,
`language` and the message differ (the twin names its own suppression id).

**This is enforced, not documented-and-hoped:** `pnpm test:twins`
(`src/twinCoverageTest.ts`, part of `pnpm check`) fails when a rule family has
only one arm and no entry in its `EXCEPTIONS` table, and when two arms that do
exist have drifted apart. Each exception says *why* — either the missing arm is
impossible (the rule matches JSX nodes, or its `files:` globs name only one
extension) or it is a real gap, and then the entry carries the measurement and
the issue that owns it. The failure this prevents is specific and has happened:
a rule pointed at a language it cannot match reports zero, which is exactly what
a correct rule with nothing to find reports. `test:rules` catches that for every
rule it asserts; `test:twins` catches the arm that was never written.

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

`guardrails verify` and `verify-diff` scan with **both** configs — the bundled
canon and, when the working directory has one, the repo's own `sgconfig.yml` —
and merge the findings, deduped by rule + file + line (the repo config almost
always lists the canon `ruleDir` too, so every canon finding otherwise arrives
twice). Two directions matter and both are pinned by `pnpm test:repo-rules`:

- Repo-local rules run under `verify`, gate on error tier, and print their own
  rule id, so a local rule suppresses under its own name. In 0.1.0 they did
  not run at all — `verify` read only the package's config, and the intranet and
  DataSpool each added a bare `ast-grep scan -c sgconfig.yml` as a second gate
  stage to work around it.
- A repo whose `sgconfig.yml` forgets the canon `ruleDir` does **not** lose the
  canon. The canon is always scanned; the repo's config is additive.

A repo `sgconfig.yml` that ast-grep cannot load (unreadable `ruleDir`, unparsable
YAML) exits 2 with ast-grep's own reason. It never reads as "no findings" — a
rule set that failed to load reports exactly what a rule set with nothing to find
reports, and that silence is the failure this package exists to remove.
`guardrails doctor` lists the `ruleDirs` the repo config declares, so a repo that
believes it has local rules can see whether the config actually names them.

Keep local ids distinct from canon ids — ast-grep refuses to load two rules with
the same id, and a repo-local override of a canon rule is a silent fork rather
than a fix. If a local rule turns out to be generally useful, promote it here
with fixtures instead of copying it into a second repo.

## Development

`pnpm check` = build (tsc) + biome + fixture harness + twin coverage +
gate-can-go-red test + metrics/init/severity/screens/hooks/iterate/leaks.
CI runs exactly that, blocking.
