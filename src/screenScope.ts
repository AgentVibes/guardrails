import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./findings.js";
import { rulesDir } from "./packagePaths.js";
import { readTomlTable } from "./tomlTable.js";

// Screens are not leaf components, and one canon rule cannot tell them apart.
//
// `direct-store-import` bans pulling a store class or slice-store singleton into
// a component file. A SCREEN is required to do exactly that — report §8's shape
// is `usePageStore(() => new GalleryPageStore(rootStore, slug))`, which needs
// the class imported — so the rule fires on the form the canon prescribes. Its
// own header predicted this and named the fix: the boundary needs the repo to
// say where its screens are, because an ast-grep `files:` glob is per-rule-file
// and cannot read a manifest (is-7067a0b8).
//
// Measured before choosing this shape rather than after: the canon's own screen
// marker `**/*.screen.tsx` matches ZERO files across observatory, tg-gallery and
// merkle-substrate, while `screens/` directories exist in two of the three. So
// no naming convention in the park can carry this, and a rule-side `ignores:`
// glob would have been a guess about layout dressed as a fix.
//
//   [verify]
//   screens = "^src/screens/"
//
// The key states a FACT ABOUT THE REPO — these paths are screens — not a
// suppression of a rule. That distinction is the whole design: a per-rule path
// map in user config would be an allowlist that grows, and which rules stop
// applying to screens is the canon's business, declared in the rule itself:
//
//   metadata:
//     appliesTo: not-screens
//
// Absent key = absent behaviour. A repo that says nothing is scanned exactly as
// it was before this existed.
//
// GENERALISED (is-086a90ac). A second fact needed saying and the shape already
// fitted: `no-local-kit-clone` is error-tier and fires on the six declarations
// inside `@agentvibes/kit` itself — the canonical definitions the rule tells
// everyone else to import. Its own header names the fix ("if this IS the
// canonical definition … it belongs behind the path carve-outs") and its
// carve-out globs, written while the package did not exist yet, are
// `**/packages/kit/**` and `**/agentvibes-kit/**`: neither matches a standalone
// repo whose files verify sees as `src/resource/resource.ts`. No path glob can
// tell that tree from any other repo's `src/` — only the repo knows, so the
// repo says it:
//
//   [verify]
//   kit_source = "^src/"
//
// Adding a scope is two lines here plus `appliesTo: not-<scope>` in the rules
// that stand down for it. The registry is closed on purpose: an unknown scope
// key in a repo's config is a typo the repo cannot see, and the alternative — a
// free-form per-rule path map — is the growing allowlist this design refused.
export class ScreenScopeError extends Error {}

export interface Scope {
  /** The name in `appliesTo: not-<name>`. */
  readonly name: string;
  /** The key under `[verify]` in .agentvibes/project.toml. */
  readonly tomlKey: string;
}

export const SCOPES: readonly Scope[] = [
  { name: "screens", tomlKey: "screens" },
  { name: "kit-source", tomlKey: "kit_source" },
];

/** scope name -> rule ids whose bundled definition declares `appliesTo: not-<scope>`. */
export function scopeExemptRuleIds(dir: string = rulesDir): Map<string, Set<string>> {
  const byScope = new Map<string, Set<string>>(SCOPES.map((s) => [s.name, new Set<string>()]));
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yml")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const id = text.match(/^id:\s*(\S+)/m)?.[1];
    if (id === undefined) continue;
    for (const s of SCOPES) {
      if (new RegExp(`^\\s{2}appliesTo:\\s*not-${s.name}\\s*$`, "m").test(text)) {
        byScope.get(s.name)?.add(id);
      }
    }
  }
  return byScope;
}

/** Rule ids whose bundled definition declares `appliesTo: not-screens`. */
export function screenExemptRuleIds(dir: string = rulesDir): Set<string> {
  return scopeExemptRuleIds(dir).get("screens") ?? new Set<string>();
}

/**
 * The repo's `[verify] screens` pattern, or undefined when it declares none.
 *
 * An unusable pattern throws rather than being dropped: a scope the gate cannot
 * honour must fail loudly, the same posture `[severity]` takes on an unknown
 * rule id. Silently ignoring it would leave every screen flagged while the repo
 * believes it has scoped them.
 */
export function screensPattern(cwd: string): RegExp | undefined {
  return scopePatterns(cwd).get("screens");
}

/** Every scope pattern the repo declares, keyed by scope name. */
export function scopePatterns(cwd: string): Map<string, RegExp> {
  const table = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "verify");
  const out = new Map<string, RegExp>();
  for (const s of SCOPES) {
    const raw = table[s.tomlKey];
    if (raw === undefined || raw.trim() === "") continue;
    try {
      out.set(s.name, new RegExp(raw));
    } catch (e) {
      throw new ScreenScopeError(
        `[verify] ${s.tomlKey} = ${JSON.stringify(raw)} is not a valid regular expression (${(e as Error).message})`,
      );
    }
  }
  return out;
}

/**
 * Drop findings from rules that do not apply to a scope, in files the repo has
 * declared to BE that scope. Everything else passes through untouched —
 * including those same rules outside the scoped paths, which is the half that
 * has to keep working for the scoping to be worth anything.
 */
export function dropScopeExempt(
  findings: readonly Finding[],
  patterns: ReadonlyMap<string, RegExp>,
  exempt: ReadonlyMap<string, Set<string>>,
): Finding[] {
  if (patterns.size === 0) return [...findings];
  return findings.filter((f) => {
    for (const [scope, re] of patterns) {
      if (exempt.get(scope)?.has(f.rule) === true && re.test(f.file)) return false;
    }
    return true;
  });
}
