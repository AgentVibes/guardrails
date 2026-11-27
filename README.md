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

**Biome must be 2.5 or newer.** The preset writes
`linter.rules.preset: "recommended"`, a key biome 2.4 does not know, so an older
biome refuses the whole config rather than degrading — it lints nothing and says
`Found an unknown key 'preset'`. Biome v1 refuses it harder still, on
`includes`, `root` and `assist` as well. Measured across the fleet on
2026-09-07: of 18 repos with a readable biome, twelve were on 1.9.4.

Adopting the preset, and what a repo may keep in its own `biome.json`, is
[Presets](#presets) below. Drift fails `guardrails verify` (exit 2) and
`guardrails doctor` (exit 1) in every repo, so migrate before you upgrade.

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
| `guardrails verify [paths]` | full scan: rule canon + text-greps + structure (one component per file, 120-line error / 90-line warning); in a repo with Rust, also clippy and rustfmt ([Rust](#rust)) | 1 on any error-tier finding, else 2 when a check could not run |
| `guardrails verify-diff [--base R]` | ratchet: error-tier findings on lines your diff ADDED vs merge-base; falls back to whole-file, then whole-tree — never to silence; also judges every file the diff grew against the [per-file length ratchet](#per-file-length-ratchet) | 1 on new findings only, else 2 when a check could not run |
| `guardrails doctor` | languages, tool versions + resolution route (cargo, clippy, rustfmt for Rust), ruleset SHA, config discovery, [wiring](#wiring) | 1 if a tool an enabled language needs is missing |
| `guardrails init` | writes `sgconfig.yml`, `biome.json` (extends the preset), and a detected-and-materialized `[stack]` in `.agentvibes/project.toml`; for Rust, the lint table, `rust-toolchain.toml`, `clippy.toml` and the hooks ([Rust](#rust)) | 0 |
| `guardrails metrics [paths]` | per-component (loc, hooks, props, observer, JSX depth, branching), per-file (sloc, context-cost) and per-project metrics; `--check` compares the GATED set against the committed `.guardrails/metrics.json` baseline (recomputes facts, never trusts the file); `--update-baseline` tightens it (2% hysteresis, never loosens without `--force`); a gated metric the baseline has no entry for (the file predates the release that gated it) is reported as not yet gated instead of failing, and `--update-baseline` adopts its current value; `--snapshot` appends a JSONL trend row. Both `--check` and `--update-baseline` also run the [per-file length ratchet](#per-file-length-ratchet) | 1 on ratchet regression, 2 when `--check` finds no baseline or the length threshold is invalid |
| `guardrails snapshot [path]` | records one checkout (default `.`) into the [recording database](#recording), whether or not that repo uses guardrails; writes nothing into it | 2 when the path is not a directory or the record cannot be written; never 1 |
| `guardrails time [--name N] -- CMD` | runs CMD with its output passed through; while [recording](#recording), stores its wall-clock time in ms as metric N (default `build_ms`) when it exits 0 | CMD's own exit code; 127 when CMD cannot start; 2 on a usage error |
| `guardrails build\|lint\|typecheck\|test\|format [-- args]` | runs the fastest detected provider for the verb ([Tasks](#tasks)) and records duration as `task:<verb>` | tool's own exit code; 2 if provider binary missing or config invalid |
| `guardrails run <file> [args]` | runs `<file>` with native Node type stripping (`>= 22.18/23.6`) else `bun`, recording as `task:run` | script's own exit code; 2 if binary missing |
| `guardrails providers` | lists all task verbs, available providers, which is active and why | 0 (2 on bad `[tasks]` config) |

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

## Per-file length ratchet

No production file may hold more than **500 SLOC** (lines minus imports,
blank lines and comment-only lines — the `file_sloc` that `metrics` reports).
Test files, stories, showcases and `.d.ts` files are excluded, as for every
metric. So is every file in a test directory (`tests/`, `test/`, `e2e/`,
`spec/`, `__tests__/`, `__e2e__/`, `__mocks__/`), such as a shared harness or an
end-to-end script; the recorded `files_over_sloc_limit` counts the same files.
Files that were already longer when a repo adopted the ratchet are
listed in a committed baseline, `.guardrails/file-sloc.json`, each with its own
ceiling:

```json
{ "version": 1, "threshold": 500, "files": { "src/legacy/bigStore.ts": 812 } }
```

- A listed file fails when it grows past its ceiling.
- Any other file fails when it crosses the threshold (exactly 500 passes).
- `guardrails metrics --update-baseline` lowers a ceiling as soon as its file
  shrinks (no hysteresis: SLOC is an exact count), and drops the entry once the
  file is back under the threshold or deleted. It never raises a ceiling and
  never lists a new file; only the first creation and `--force` do, and that
  diff is reviewed like any other loosening.
- A renamed listed file keeps its ceiling: renames since the merge base are
  followed by `verify-diff`, `metrics --check` and `--update-baseline`.

Where it runs: `guardrails metrics --check` judges every file in its targets;
`guardrails verify-diff` (and so `hook-stop`) judges only the files the diff
grew — untracked files and files with added lines on the added-lines rung,
every changed file on the whole-file rung, every file on the whole-tree rung.
A pure rename or a deletions-only edit is not judged. Without a baseline file
nothing is grandfathered: run `guardrails metrics --update-baseline` once and
commit `.guardrails/file-sloc.json` next to `metrics.json`.

The threshold is configurable; a value that is not a positive integer exits 2
instead of falling back to the default:

```toml
# .agentvibes/project.toml
[metrics]
max_file_sloc = 400
```

`GUARDRAILS_MAX_FILE_SLOC` in the environment overrides the file.

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
the relative escapes resolve. **Each sibling path is removed and re-cloned on
every run.** A self-hosted runner keeps its `_work` directory between jobs and
`actions/checkout` cleans only its own path, so the leftovers used to make the
step exit 128 on every run after the first — before install, so the ratchet
showed as `skipped` rather than as not-run. Re-cloning also keeps
the sibling current: gating against last week's sibling is a wrong answer, not
a cheap one. Listing the repo under test in `sibling_repos` is refused — that
path holds the run's own checkout. Private siblings additionally need
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

## Agent hooks

guardrails has two Claude Code hooks: `hook-postedit` after every edit and
`hook-stop` when the agent wants to stop (both below). They live in the
repo's `.claude/settings.json`, so they also run in a checkout where nobody
ran `pnpm install` yet, such as a fresh worktree. A bare
`pnpm exec guardrails hook-postedit` fails there with "command not found",
and the agent sees that error after every edit.

So each command first checks that the package is installed, and exits 0
without output when it is not. This is the form `guardrails init` writes in
a pnpm repo:

```json
{ "hooks": {
  "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "timeout": 120,
    "command": "sh -c '[ -x \"${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/guardrails\" ] || exit 0; exec pnpm exec guardrails hook-postedit'" }] } ],
  "Stop": [ { "hooks": [{ "type": "command", "timeout": 360,
    "command": "sh -c '[ -x \"${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/guardrails\" ] || exit 0; exec pnpm exec guardrails hook-stop'" }] } ] } }
```

The check reads `$CLAUDE_PROJECT_DIR` (Claude Code sets it to the project
root), or the current directory when it is not set. With a
`package-lock.json` the command runs `npx --no-install guardrails`; with a
`yarn.lock` it runs `yarn guardrails`, and an install state in
`.yarn/install-state.gz` (Plug'n'Play) also counts as installed. In a repo
without a lockfile it runs a `guardrails` found on `PATH`, and does nothing
when there is none.

**Upgrade.** `guardrails init` rewrites a hook in the old form
(`pnpm exec guardrails hook-…`, `yarn guardrails hook-…`,
`npx [--no-install] guardrails hook-…`, nothing else in the command) to the
form above, in any repo. It keeps the matcher, timeout and all other
settings, and leaves any other command alone, including one behind a wrapper.
`doctor` still passes the old form, with an `upgrade:` line under the check.
In a Rust repo `init` also adds a hook that is missing; in a TypeScript-only
repo it adds none.

## Stop hook

`guardrails hook-stop` is the "cannot say done over red findings" echelon: on
Claude Code's Stop event it runs the verify-diff ratchet over the session's
changed files and blocks the stop while NEW error-tier findings remain. Loop
breaker built in: after 3 blocks in one session (env
`GUARDRAILS_STOP_MAX_BLOCKS`) it stops blocking and prints a loud warning
instead — a wedged agent is worse than undercleaned code, and CI holds the
same line anyway. Like hook-postedit, it never fails the session on its own
defects.

Wire it with the command from [Agent hooks](#agent-hooks).

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
context. Wire it in settings.json with the command from
[Agent hooks](#agent-hooks).

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
| c | a second `biome.json` / `biome.jsonc` exists in the tree anywhere outside `node_modules` — build output (`dist`, `.next`, `coverage`) and dot-directories (`.claude`, `.git`, `.turbo`) included. An agent worktree kept inside the repo (`.claude/worktrees/<name>/`) carries its own `biome.json` and is reported when you run `verify` locally; CI checkouts have none | two configs means two answers |

Everything else stays legal, because it scopes or configures a parser rather
than restyling: `$schema`, `files` (a repo decides which of ITS paths are
linted), a language block such as `css.parser.tailwindDirectives`, and an
`overrides` entry that only turns `suspicious.noConsole` off for some paths (a
CLI has to print) or `suspicious.noEmptyBlockStatements` off for TEST paths.
A key is allowed exactly
when this check allows it, so this list and the code are one rulebook.

**Drift gates everywhere.** `verify` exits 2 and `doctor` exits 1, with the
offending keys named. Up to 0.2.4 this was opt-in through
`[biome] preset = "enforced"` in `.agentvibes/project.toml`; that line is now
inert and can be deleted. Valid and invalid example trees are in
`test/preset-drift/`.

The reusable gate workflow runs `verify-diff`, not `verify`, so a repo should
add a `guardrails doctor` (or `verify`) step to its own CI to gate drift there.

A rule the list above does not allow becomes legal when the repo declares it
with a reason (see "Overrides" below): an `[[override]]` with
`kind = "biome-rule"`, the same `<group>/<rule>`, the override entry's
`includes` exactly as `paths` (none for a repo-wide `linter.rules`), and a
non-empty `reason`. A top-level `linter` is then allowed only when it holds
nothing but declared `rules`. A declaration with other paths or no reason does
not count, and `extends`, the formatter keys, `assist` and a second config are
never escapable: they fork the preset.

## Overrides

An override is any place a repo deviates from the canon. `guardrails verify`
and `guardrails doctor` list every one with its reason. Each override is a
warning finding, `canon-overridden`, even when it has a reason: the reason makes
the deviation legitimate, not invisible. A reason-less one is a second warning,
`override-without-reason`. Warnings do not change an exit code. A repo that is
wired but overrides anything counts as partially wired, not fully wired.
`verify --json` and `doctor --json` carry the list as `overrides`; from
code, `collectOverrides(root)` from `@agentvibes/guardrails/overrides` returns it.

| kind | what | where the reason goes |
|---|---|---|
| `ast-grep-ignore` | `// ast-grep-ignore: <id>[, <id>]`, `/* … */`, the JSX form `{/* … */}`, and the bare `// ast-grep-ignore` (every rule, listed as `*`) | in the comment: `-- <why>` after the ids |
| `biome-ignore` | `// biome-ignore[-all\|-start] lint/<group>/<rule>` | in the comment: `: <why>`; biome's placeholder `<explanation>` is not a reason |
| `verify-scope` | `[verify] screens`, `kit_source`, `exclude` | `[[override]]`, `rule` = the key |
| `biome-rule` | a rule in a `biome.json` `overrides` entry or in `linter.rules`, `noConsole` included | `[[override]]`, `rule` = `<group>/<rule>`, `paths` = the entry's `includes` |
| `repo-rule-shadow` | a rule in a repo `ruleDir` that reuses a canon rule id | `[[override]]`, `rule` = the id |
| `metrics-limit` | `[metrics] max_file_sloc` above the default 500 | `[[override]]`, `rule = "max_file_sloc"` |

```toml
# .agentvibes/project.toml
[[override]]
kind   = "biome-rule"
rule   = "suspicious/noUndeclaredEnvVars"
paths  = ["**/scripts/**"]
reason = "deploy scripts read env set by the CI runner"
```

Not overrides: a `[severity]` raise and a lower `max_file_sloc` make the gate
stricter, and a severity lowering is refused outright. A declaration that
matches nothing in the repo is a warning, `override-declared-unused`. An
`[[override]]` table that does not parse, or names an unknown kind or key, is
drift: `verify` exits 2 and `doctor` exits 1 with the entry named.

Inline directives are read only where they start a line. A directive after code
on the same line is not listed. Text that looks like a directive at the start of
a line inside a template string is listed, because the scan does not parse
strings.

## Wiring

`guardrails doctor` reports whether guardrails actually runs in the repo, as
separate checks, each with its evidence (`doctor --json` → `wiring`; from
code, `detectWiring(root)` from `@agentvibes/guardrails/wiring`):

| check | passes when |
|---|---|
| `installed` | the root `package.json` lists `@agentvibes/guardrails` in `dependencies` or `devDependencies` |
| `sgconfig-canon` | `sgconfig.yml` `ruleDirs` lists `node_modules/@agentvibes/guardrails/rules`, so editors and bare `ast-grep` runs see the canon |
| `lint-script` | the `lint` or `check` script runs `guardrails verify\|verify-diff\|doctor\|metrics\|leaks`, directly, through one other package script, or through one file it runs (`scripts/lint/gate.sh`) |
| `ci` | a file in `.github/workflows`, `.gitea/workflows` or `.gitlab-ci.yml` uses the reusable gate, runs guardrails, or runs the lint script that passed above |
| `hook-postedit` | `.claude/settings.json` has a `PostToolUse` hook whose command runs `guardrails hook-postedit`, through any wrapper; the old form without the install check passes with an `upgrade:` hint ([Agent hooks](#agent-hooks)) |
| `hook-stop` | the same for a `Stop` hook and `guardrails hook-stop` |
| `preset` | no undeclared biome preset drift |

The state is `on` when every check passes AND the repo has no override of the
canon (see "Overrides"); `off` when nothing but the preset check passes;
`partial` otherwise, which includes "fully wired, but overrides something".
Wiring is a report: it never changes `doctor`'s exit code, which stays the
tools-and-drift verdict.

The TypeScript checks (`installed`, `sgconfig-canon`, `lint-script`, `ci`,
`preset`) run only when TypeScript is enabled, the `rust.*` checks only when
Rust is (see [Languages](#languages)); the two hook checks are shared. A
Rust-only repo is `on` with the hook checks and the four Rust checks.

## Languages

guardrails runs one adapter per language. A repo's languages are detected:

| language | detected by |
|---|---|
| `typescript` | `package.json` or `tsconfig.json` in the repo root |
| `rust` | a `Cargo.toml` anywhere in the checkout, except under `node_modules`, `target`, `.git` and fixture directories (`fixtures`, `testdata`, `test-fixtures`) |

Both found means a mixed repo, and both adapters run. Neither found means
`typescript`, which is what guardrails did before it knew other languages.
`doctor` prints the languages and the evidence. To set the list yourself:

```toml
# .agentvibes/project.toml
[languages]
enabled = ["rust"]   # or ["typescript"], or both
```

An unknown language, an empty list or an unknown key is a config error:
`verify` exits 2 and `doctor` exits 1, with the problem named.

## Rust

For Rust, guardrails does not bring its own rules: the rules are Clippy's,
and guardrails checks that a repo runs Clippy strictly, lists every place it
switches a lint off, and gates new findings on the lines a diff added.

**Commands.**

- `verify` runs `cargo clippy --workspace --all-targets
  --message-format=json --keep-going -- --cap-lints warn` and `cargo fmt
  --all --check` in every Cargo root (a workspace root, or a crate that is in
  no workspace). The lint cap makes cargo check every crate even when one
  crate has a deny-level finding; each finding keeps its original level in
  the message, and every finding is error tier, because CI runs Clippy with
  `-D warnings`. `snapshot` observes rather than gates, so it records each
  finding at Clippy's own level: a `warn` lint is a warning there, a
  `deny` lint an error.
- `verify-diff` runs the same checks only in Cargo roots where a `.rs` file
  changed, and fails only on findings on added lines (the same rungs as
  TypeScript: added lines vs merge-base, else whole changed files, else the
  whole tree).
- `hook-postedit` on a `.rs` file runs `cargo clippy -p <package>` for the
  package that owns the file, and reports findings in that file on the
  lines the edit changed. For a whole-file write of a tracked file, findings
  on lines that are already in `HEAD` are warnings.
- `hook-stop` runs the `verify-diff` check for the session.
- `snapshot` runs the full check with `--locked` and, unless
  `CARGO_TARGET_DIR` is set, a target directory under
  `$XDG_CACHE_HOME/agentvibes/guardrails/cargo-target/`, so it writes nothing
  into the repo.

**Vendored crates and how clippy runs.** `[verify] exclude` (the regex of
[Scopes](#scopes--the-repo-states-a-fact-the-canon-says-which-rules-stand-down))
also applies to Rust: a `Cargo.toml` whose repo-relative path matches is not
a Cargo root, so `doctor`, `verify`, `verify-diff`, `snapshot` and the
hooks skip it; a workspace member there is passed to clippy as `--exclude`;
and findings in matching paths are dropped (cargo still compiles such a
crate when another one depends on it).

By default each Cargo root gets one host run of `cargo clippy --workspace`.
`[[rust.cargo]]` in `.agentvibes/project.toml` replaces that for one root
with one run per entry:

```toml
[[rust.cargo]]
root = "."                          # the Cargo root, repo-relative ("." = repo root)
exclude_packages = ["web"]          # --workspace --exclude web

[[rust.cargo]]
root = "."
target = "wasm32-unknown-unknown"   # --target …; "host" (the default) = no --target
packages = ["web"]                  # -p web instead of --workspace
```

| key | default | meaning |
|---|---|---|
| `root` | `"."` | the directory of the Cargo root the entry is for; it must be one `doctor` lists |
| `target` | `"host"` | a target triple passed as `--target` |
| `packages` | `[]` | run `-p` for these packages only |
| `exclude_packages` | `[]` | run `--workspace --exclude` for these packages |

`packages` and `exclude_packages` cannot both be set in one entry. A root
or package name that does not exist is a config error (exit 2 with the
reason), never a run that checks less than it says. `verify`,
`verify-diff`, `snapshot` and `hook-postedit` use the same runs; rustfmt
still runs once per root. A crate that two runs both check (a host run and a
wasm32 run) reports a lint once: identical findings (same rule, file, line,
column and message) from several runs are merged. **A member that no run checks is not checked at
all**: `verify-diff` does not run cargo for a change only there, its
findings are dropped, and the [override inventory](#overrides) lists it as a
`verify-scope` override (`rule = "rust.cargo"`) that needs a reason:
`[[override]] kind = "verify-scope", rule = "rust.cargo", reason = "…"`.

A crate whose path dependency is generated at build time cannot be left out
this way: cargo loads the whole workspace, every member's path dependencies
included, before it selects packages, so `--exclude` does not help. Generate
the dependency before the check, or move the crate out of the workspace
(Cargo's own `[workspace] exclude`) and into `[verify] exclude`.

cargo runs with your environment: `RUSTC_WRAPPER` (sccache) and
`CARGO_TARGET_DIR` are used as set. `GUARDRAILS_CLIPPY_TIMEOUT_S` limits each
cargo call; without it, `verify` and `verify-diff` have no limit,
`hook-postedit` has 90 s, `hook-stop` 300 s and `snapshot` 900 s.

**A check that cannot run is never a pass.** A build that does not compile,
a manifest cargo cannot load, a missing toolchain or a timeout makes that
check `unavailable` with the reason. `verify` and `verify-diff` print the
reason and exit 2 (exit 1 still wins when there are error findings), and a
recorded run stores the findings part as `unavailable`, not as zero. In a
mixed repo, the TypeScript findings are still recorded and
`projects_latest.findings_unavailable` names the language that could not be
measured. The hooks never fail an edit or a stop because of a tooling
problem: they print the reason on stderr and exit 0.

**Wiring checks** (`doctor`; each with its evidence):

| check | passes when |
|---|---|
| `rust.clippy-strict` | the lint table that governs each Cargo root (`[workspace.lints]` in a workspace root, `[lints]` in a single crate) has every canon entry at the canon level or stricter, and `pedantic` and `nursery` at `warn` or above with priority -1 or lower; in a workspace, also when every crate clippy checks has its own `[lints]` that meets the canon (members under `[verify] exclude` or left out of every `[[rust.cargo]]` run do not count) |
| `rust.lints-inherited` | every workspace member has `[lints] workspace = true` (a member with its own `[lints]` table fails, and its table is compared with the canon as an override); a workspace with no `[workspace.lints]` whose checked crates each carry the canon passes, as there is nothing to inherit |
| `rust.toolchain` | `rust-toolchain.toml` (or `rust-toolchain`) is in the Cargo root or the repo root |
| `rust.ci` | a CI workflow, or a script it runs, runs `cargo clippy` with `-D warnings` (on the command line or in `RUSTFLAGS`) and `cargo fmt --check`, or runs `guardrails verify`, `verify-diff` or the reusable gate |

**`init`** in a repo with Rust appends the canon to each Cargo root that has
no lint table, adds `[lints] workspace = true` to each member without
`[lints]`, writes `rust-toolchain.toml` (the installed stable version, with
`clippy` and `rustfmt`) and `clippy.toml` when they are missing, and adds the
`PostToolUse` and `Stop` hooks to `.claude/settings.json`. It only adds: an
existing table or file is left as it is and reported as skipped. In a repo
without TypeScript it writes none of the TypeScript files.

### The Clippy canon

The canon is `configs/rust-lints.toml` in this package. It follows common
Clippy practice for code that agents write: the strict groups as warnings
that CI turns into errors, plus the restriction lints that stop the usual
shortcuts.

| entry | level | why |
|---|---|---|
| `clippy::pedantic` | warn, priority -1 | the stricter default lints (casts that lose data, missing `#[must_use]`, needless pass-by-value). Priority -1 puts the group under single lints, so one lint can still be raised or, with a reason, lowered. |
| `clippy::nursery` | warn, priority -1 | newer lints that catch real mistakes (`missing_const_for_fn`, `significant_drop_tightening`). They are still maturing, so a false positive is an `#[expect]` with a reason, not a reason to drop the group. |
| `clippy::unwrap_used` | deny | an `unwrap()` turns a recoverable error into a panic and hides the error path. Return the error with `?`, or handle the `None`. |
| `clippy::expect_used` | deny | the same as `unwrap()` with a message. Where a panic is really right, say why with `#[expect(clippy::expect_used, reason = "…")]`. |
| `clippy::panic` | deny | an explicit `panic!` in library code is an error path nobody can handle. |
| `clippy::todo` | deny | `todo!()` compiles and then panics at run time: unfinished code that looks finished. |
| `clippy::unimplemented` | deny | the same, for `unimplemented!()`. |
| `clippy::dbg_macro` | deny | `dbg!` is debugging output left in the code. |
| `clippy::allow_attributes` | deny | `#[allow]` stays silent when the lint no longer fires, so it outlives its cause. `#[expect]` warns when it is no longer needed. |
| `clippy::allow_attributes_without_reason` | deny | every switched-off lint says why, with `reason = "…"`, the Rust form of `ast-grep-ignore: <rule> -- <why>`. |
| `clippy::undocumented_unsafe_blocks` | deny | every `unsafe` block has a `// SAFETY:` comment that says why it is sound. |
| `rust::unsafe_code` | deny | no `unsafe` unless a crate opts in, with a reason, where it really needs it. |

A repo may be stricter (`warn` → `deny`, `deny` → `forbid`). A canon lint set
lower, and any lint set to `allow`, is an override (below).

**Test code.** The shipped `clippy.toml` sets `allow-unwrap-in-tests`,
`allow-expect-in-tests` and `allow-panic-in-tests`: a failing test should
panic, and the error path it would otherwise need is noise. Nothing else is
relaxed for tests by Clippy. In the override list, an `#[allow]` or
`#[expect]` that has a `reason` and is in test code (a `#[cfg(test)]` or
`#[test]` item, a `cfg_attr(test, …)`, or a file under `tests/`, `benches/`
or `examples/`) is not listed; one without a reason is listed as usual. A
file-level `#![allow(…)]` or `#![expect(…)]` (at the top of a file, so it
covers the whole file, or the whole test crate for `tests/*.rs`) is always
listed, with its reason. A reason that is only a placeholder,
`reason = "<explanation>"` or `"<why>"`, counts as no reason.

**Overrides.** Two kinds are added to the [override inventory](#overrides):

| kind | what | where the reason goes |
|---|---|---|
| `rust-allow` | each lint named in `#[allow(…)]`, `#![allow(…)]` or `#[expect(…)]`, also inside `#[cfg_attr(…, …)]`; text in comments and strings is not read | `reason = "…"` in the same attribute |
| `cargo-lint` | a canon lint set lower than the canon, or any lint set to `allow`, in the lint table that governs a crate | `[[override]]`, `kind = "cargo-lint"`, `rule` = `clippy::<name>` (or `rust::<name>`), `paths` = the `Cargo.toml` |

To fix a finding or switch it off: fix it, or put
`#[expect(<lint>, reason = "<why this is legitimate>")]` on the item.

## Recording

guardrails can write what each run saw into a SQLite database, one row per
run, for dashboards and terminal views that compare many repos. Recording is
off unless you turn it on.

| `GUARDRAILS_RECORD` | effect |
|---|---|
| unset, empty or `0` | nothing is recorded |
| `1` | record to the configured database, else the default one |
| a path (`~/` is expanded) | record to that database |

- Configured database: `[record] db = "<path>"` in
  `$XDG_CONFIG_HOME/agentvibes/guardrails.toml` (`~/.config/…` when
  `XDG_CONFIG_HOME` is unset). Any other key under `[record]` is an error.
- Default database: `$XDG_STATE_HOME/agentvibes/guardrails.sqlite`
  (`~/.local/state/…` when unset). The directory is created on first write.

`verify`, `verify-diff`, `metrics`, `hook-stop` and `time` record. `hook-postedit`,
`doctor`, `init`, `leaks`, `deploy` and `iterate` do not. A database that
cannot be written prints one line on stderr and never changes the exit code:
a state database is not a gate.

`guardrails snapshot [path]` always records: with `GUARDRAILS_RECORD`
unset it uses the configured or default database. It measures every part
over the whole checkout, each on its own: a part that fails (preset drift, a
repo `sgconfig.yml` pointing at a canon that is not installed, a bad
`[[override]]` table) is recorded `unavailable` with the reason, and the
rest is still recorded. So a repo that does not use guardrails gets wiring
`off` and its metrics. It writes nothing into the repo, and a relative
`GUARDRAILS_RECORD` path is resolved where the command was typed. To record
many repos: `for r in ~/src/*/; do guardrails snapshot "$r"; done`. Node 22.13 or later is needed
(`node:sqlite`); it is loaded only when a run records.

Readers import `SCHEMA_VERSION`, the table and column maps and row types from
`@agentvibes/guardrails/record`. The database is in WAL mode, so a reader can
read while a run writes; writers wait up to 5 s for each other.

### What a run measures

A run records four parts. Each is `measured` (over the `full` checkout, a
`diff`, or given `paths`), `unavailable` (attempted, failed; with the
reason), or `skipped` (this command does not measure it).

| command | findings | overrides | wiring | metrics |
|---|---|---|---|---|
| `verify` | all tiers, `full` or `paths` | same scope | `full` | skipped |
| `verify-diff` | error tier only, `diff` | `full` | `full` | skipped |
| `hook-stop` | error tier only, `diff` | skipped | skipped | skipped |
| `metrics` | skipped | skipped | skipped | `full` or `paths` |
| `snapshot` | all tiers, `full` | `full` | `full` | `full` |
| `time` | skipped | skipped | skipped | `full` (one metric), or `unavailable` when CMD did not exit 0 |

### Schema (version 2)

Times are ISO-8601 UTC text. Booleans are `0`/`1`. `NULL` means "not
measured", never zero. The schema version is `PRAGMA user_version`; a newer
version than this guardrails knows is refused, never written.

**History tables** (appended, never rewritten):

| table | one row per | columns |
|---|---|---|
| `repos` | repo | `key` (unique), `host`, `owner`, `name` |
| `runs` | run | `repo_id`, `at`, `command`, `root`, `sha`, `branch`, `duration_ms`, `exit_code`, `guardrails_version`, `node_version`, `ast_grep_version`, `biome_version`, `wiring`, `errors`, `warnings`, `overrides`, `overrides_without_reason`, `languages` (v2: the enabled languages, comma-separated, `typescript,rust`; `NULL` for a v1 run) |
| `run_parts` | run × part, and run × language for findings | `run_id`, `part` (`findings`/`overrides`/`wiring`/`metrics`), `status` (`measured`/`unavailable`/`skipped`), `scope` (`full`/`diff`/`paths`), `reason`, `language` (v2: `NULL` for the part of the whole run; a `findings` row per language checked, `typescript` or `rust`) |
| `run_wiring` | run × wiring check | `run_id`, `check_id`, `pass`, `detail`, `adapter` (v2: `shared` for the hook checks, `typescript`, or `rust` for `rust.*`) |
| `run_rule_counts` | run × rule × tier × source | `run_id`, `rule`, `tier`, `source`, `count`, `tool` (v2: `ast-grep`, `guardrails`, `clippy`, `rustc`, `rustfmt`) |
| `run_findings` | finding, at most 200 per run, errors first | `run_id`, `rule`, `tier`, `source`, `file`, `line`, `message`, `tool` (v2) |
| `run_overrides` | override | `run_id`, `kind`, `rule`, `where`, `file`, `line`, `reason`, `has_reason` |

The repo key is `host/owner/name` from the `origin` remote: lowercase,
without `.git`, without `user:token@`, without a port. The scp form
(`git@host:owner/name`) and `ssh://` are read too. A GitLab subgroup stays in
the owner (`group/sub`). A checkout with no usable origin is
`local/<directory>`.

`runs.errors` and `runs.warnings` count code findings only: the
`canon-overridden` and `override-without-reason` warnings restate
`runs.overrides`, so they are counted there, and kept by source in
`run_rule_counts`. `runs.warnings` is `NULL` for an error-tier-only run.

**Latest tables**, for faceted browsers: one row per entity, refreshed for a
repo inside the same transaction as each run. Every one is `STRICT`, has a
single `id INTEGER PRIMARY KEY`, and only `INTEGER`, `REAL` and `TEXT`
columns. A part refreshes them only when measured over the `full` checkout,
so a diff run or a metrics run never blanks what a full `verify` measured;
the `*_run_id` columns say which run each group of columns came from.

| table | one row per | columns |
|---|---|---|
| `projects_latest` | repo | `key`, `host`, `owner`, `name`; `wiring` (`off`/`partial`/`on`); `wiring_installed`, `wiring_sgconfig_canon`, `wiring_lint_script`, `wiring_ci`, `wiring_hook_postedit`, `wiring_hook_stop`, `wiring_preset`, and (v2) `wiring_rust_clippy_strict`, `wiring_rust_lints_inherited`, `wiring_rust_toolchain`, `wiring_rust_ci`; `languages` (v2), `findings_unavailable` (v2: one `<language>: <reason>` line per language whose findings could not be measured, `NULL` when all were); `errors`, `warnings`, `overrides`, `overrides_without_reason`; `sloc`, `files`, `avg_file_sloc` (REAL), `files_over_sloc_limit`, `run_in_action`, `worktrees`, `local_branches`, `build_ms`; `last_run_at`, `last_sha`, `last_branch`, `last_command`; `wiring_run_id`, `findings_run_id`, `overrides_run_id` |
| `findings_latest` | code finding of the latest full `verify` | `repo`, `rule`, `tier`, `file`, `line`, `message`, `tool` (v2) |
| `overrides_latest` | override of the latest full measurement | `repo`, `kind`, `rule`, `where`, `reason`, `has_reason`, `file`, `line` |
| `metric_history` | run × metric | `run_id`, `repo`, `at`, `metric`, `value` (REAL) |

`metric_history` holds, for each full-scope `metrics` or `snapshot` run:

- every `metrics --json` number under its key (`p90ComponentLoc`,
  `runInActionCount`, `fileCount`, `hooksTotal.useState`, …);
- `sloc` (the production TS/TSX SLOC that `metrics` measures per file),
  `avg_file_sloc`, `files_over_sloc_limit` (files over `max_file_sloc`);
- `loc` (non-blank lines of the project's code files: tracked plus
  untracked-but-not-ignored, files over 2 MB skipped), `loc_files`, and
  `loc.<language>` (`loc.typescript`, `loc.tsx`, `loc.css`, `loc.rust`, …;
  `LANGUAGES` in `@agentvibes/guardrails/record` is the extension map);
- `git_worktrees` (open worktrees, the main one included) and
  `git_local_branches`;
- `errors`, `warnings`, `overrides` and `overrides_without_reason` from a
  full `verify` or `snapshot`.

`guardrails time -- pnpm build` adds `build_ms` (or the `--name` metric,
matching `[a-z][a-z0-9_.]*`). Everything after the first `--` is the
command's, so its flags never reach guardrails. A run that does not exit 0
is still recorded, with its exit code, but stores no time: a build that
failed halfway is not a build time. A time run changes only its own metric
in `projects_latest`; the other columns keep their values.

`projects_latest` reads `files` from `fileCount`, `run_in_action` from
`runInActionCount`, `worktrees` and `local_branches` from the `git_*`
metrics, and the other metric columns by their own names.

**v1 → v2.** The migration runs on the first write by a 0.4 guardrails, in
one transaction, and only adds columns: every v1 row is kept. It backfills
`tool` from `source` (`ast-grep` stays `ast-grep`, the other sources become
`guardrails`), `findings_latest.tool` from the rule name (guardrails' own
rules are `guardrails`, the rest `ast-grep`), and `run_wiring.adapter`
(`shared` for `hook-postedit` and `hook-stop`, else `typescript`). The
`languages` columns stay `NULL` for v1 runs. A guardrails 0.3 refuses a v2
database, so upgrade every writer and reader of one database together.

"Wired but overridden" is `wiring = 'partial' AND overrides > 0`:

```sh
sqlite3 ~/.local/state/agentvibes/guardrails.sqlite \
  "SELECT key, overrides, overrides_without_reason FROM projects_latest WHERE wiring = 'partial' AND overrides > 0"
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
- `candidates/` — triaged in wave 2. Three source-app R-rules were promoted into
  `rules/`; the eight that remain are repo-local by decision, with the reason
  for each recorded in `candidates/README.md`. Still loaded nowhere.

### Scopes — the repo states a fact, the canon says which rules stand down

Some rules cannot be scoped by a glob inside the rule file, because the layout
they need to know about is the repo's, not the canon's. Those facts go in
`.agentvibes/project.toml` under `[verify]`:

```toml
[verify]
screens    = "^src/screens/"   # these paths ARE screens
kit_source = "^src/"           # this tree IS @agentvibes/kit
```

Each key states a fact about the repo — not a suppression. Which rules stop
applying is the canon's business, declared in the rule itself:

```yaml
metadata:
  appliesTo: not-screens      # direct-store-import
  appliesTo: not-kit-source   # no-local-kit-clone, + its tsx twin
```

`screens` exists because a screen owns its page store and must import the class
`direct-store-import` bans in a component; `kit_source` because
`no-local-kit-clone` is error-tier and fires on the six canonical declarations
inside `@agentvibes/kit` itself — the definitions it tells everyone else to
import.

Absent key = absent behaviour: a repo that says nothing is scanned exactly as it
was. A pattern that is not a valid regular expression exits 2 with the reason
rather than being dropped — a scope the gate cannot honour must fail loudly. The
scope registry is closed (`SCOPES` in `src/screenScope.ts`); a free-form
per-rule path map in user config would be the growing allowlist this refuses.
`pnpm test:screens` asserts both directions of each scope AND that every
registered scope has at least one rule carrying its marker — a scope nothing
declares filters nothing while looking like it works.

`exclude = "<regex>"` is the vendored-tree carve-out, tested against the
repo-relative path: a verbatim copy of another package is not this repo's
code. Its findings (every rule, every language) and its inline suppressions
are left out of `verify`, `verify-diff`, `snapshot`, the hooks and the
[override inventory](#overrides); the Rust side is under
[Rust](#rust) ("Vendored crates").

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

## Tasks

Point `package.json` scripts at `guardrails` instead of wiring slow JS tools by
hand: `"build": "guardrails build"`, `"lint": "guardrails lint"`,
`"typecheck": "guardrails typecheck"`, `"test": "guardrails test"`,
`"format": "guardrails format"`. Each verb detects the fastest applicable
native/Rust/Go tool in the repo, passes extra arguments after `--` (or after
`<file>` for `guardrails run`), records its duration under `task:<verb>` when
`GUARDRAILS_RECORD` is on, and fails loudly (exit 2) with the install hint and
config key if the active binary is missing.

| verb | default detection order | alternatives |
|---|---|---|
| `build` | `next build --turbopack`, `vite build`, `tsdown` (when `exports`/`main` present), `cargo build` (Rust) | `[build] command` / `[tasks.build]` |
| `lint` | `biome check .` + `guardrails verify-diff` + `guardrails doctor` | `oxlint` (when `.oxlintrc.json` without `biome.json`, or configured) |
| `typecheck` | `tsc --noEmit` (`typescript >= 7`), `tsgo --noEmit` (`@typescript/native-preview`), `tsc --noEmit` (`typescript < 7`, prints upgrade warning), `cargo check` (Rust) | `tsc`, `tsgo`, `cargo` |
| `test` | `vitest run`, `bun test`, `node --test`, `cargo nextest run` / `cargo test` (Rust) | `vitest`, `bun`, `node`, `cargo-nextest`, `cargo-test` |
| `format` | `biome format --write .` | `dprint` (`dprint fmt`) |
| `run` | `node` (native type stripping on `>= 22.18` / `>= 23.6`), else `bun` | `node`, `bun` |

Run `guardrails providers [--json]` to inspect every verb, which provider is
active, and why. Override any verb in `.agentvibes/project.toml`:

```toml
# .agentvibes/project.toml
[tasks.lint]
provider = "oxlint"

[tasks.build]
command = "pnpm --filter web build"

# `[build] command` is also accepted and always wins over detection:
[build]
command = "tsc -p tsconfig.build.json"
```

## Toolchain speed

`guardrails doctor` (and `doctor --json`) scans every tracked `package.json`
(root and workspaces, skipping `node_modules`) and `.github/workflows/*.yml|yaml`
`run:` lines for two kinds of slowdowns:

1. **Task script bypasses:** a `build`, `lint`, `typecheck`, `test`, or
   `format` script in `package.json` that does not call `guardrails <verb>`.
2. **Slow JS tools** defined in `configs/toolchain.json`:

| tool / package | replacement |
|---|---|
| `eslint`, `@typescript-eslint/*` | `oxlint` or `biome` |
| `prettier` | `biome` |
| `typescript` (`< 7`, without `@typescript/native-preview`) | `typescript >= 7` (or `@typescript/native-preview`) |
| `webpack` | `rspack` or `rolldown` |
| `@babel/core`, `babel-loader`, `babel-jest` | `swc` or `oxc` |
| `terser` | `oxc` or `swc` |
| `ts-node` | `guardrails run` |
| `jest` | `vitest` |

Configure `[toolchain]` in `.agentvibes/project.toml`:

```toml
[toolchain]
severity = "warning"   # "warning" (default) | "error" | "off"

[[toolchain.allow]]
tool = "webpack"
reason = "custom loader plugin not yet migrated to rspack"
```

- With `severity = "warning"` (default), `doctor`'s exit code is unchanged and
  `wiring` becomes `partial` while findings remain.
- With `severity = "error"`, `doctor` exits 1 and names every finding.
- A `[[toolchain.allow]]` entry with an empty or placeholder (`<...>`) reason
  counts as an override without a reason and does not suppress the finding.

## Development

`pnpm check` = build (tsc) + biome + fixture harness + twin coverage +
gate-can-go-red test + metrics/init/severity/screens/hooks/iterate/leaks.
CI runs exactly that, blocking.
