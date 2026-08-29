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
export class ScreenScopeError extends Error {}

/** Rule ids whose bundled definition declares `appliesTo: not-screens`. */
export function screenExemptRuleIds(dir: string = rulesDir): Set<string> {
  const ids = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yml")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const id = text.match(/^id:\s*(\S+)/m)?.[1];
    if (id === undefined) continue;
    if (/^\s{2}appliesTo:\s*not-screens\s*$/m.test(text)) ids.add(id);
  }
  return ids;
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
  const raw = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "verify").screens;
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return new RegExp(raw);
  } catch (e) {
    throw new ScreenScopeError(
      `[verify] screens = ${JSON.stringify(raw)} is not a valid regular expression (${(e as Error).message})`,
    );
  }
}

/**
 * Drop findings from rules that do not apply to screens, in files the repo has
 * declared to BE screens. Everything else passes through untouched — including
 * those same rules outside the screen paths, which is the half that has to keep
 * working for the scoping to be worth anything.
 */
export function dropScreenExempt(
  findings: readonly Finding[],
  screens: RegExp | undefined,
  exempt: ReadonlySet<string>,
): Finding[] {
  if (screens === undefined || exempt.size === 0) return [...findings];
  return findings.filter((f) => !(exempt.has(f.rule) && screens.test(f.file)));
}
