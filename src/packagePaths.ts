import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// dist/packagePaths.js sits one level under the package root.
export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const rulesConfig = join(packageRoot, "sgconfig.yml");
export const structureConfig = join(packageRoot, "structure", "sgconfig.yml");
export const rulesDir = join(packageRoot, "rules");
export const structureRulesDir = join(packageRoot, "structure", "rules");
export const fixturesDir = join(packageRoot, "rules", "__fixtures__");
export const miseToml = join(packageRoot, "mise.toml");

export const PACKAGE_NAME = "@agentvibes/guardrails";

/**
 * True when `root` is a checkout of this package's own source: either the
 * install that is running, or any directory whose package.json is named
 * `@agentvibes/guardrails`. The name matters because doctor and snapshot often
 * run from an installed copy against a separate checkout of this repo; a path
 * comparison alone would then treat the canon's own rules as a consumer's
 * shadows and the preset source as a competing biome config.
 */
export function isPackageSource(root: string): boolean {
  if (resolve(root) === resolve(packageRoot)) return true;
  const path = join(root, "package.json");
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { name?: unknown }).name === PACKAGE_NAME
    );
  } catch {
    return false;
  }
}

/**
 * A predicate for files under `rules/__fixtures__/` when `root` is this
 * package's source, else one that matches nothing. Those files are the inputs
 * the rule tests run on: `bad.ts` violates on purpose and `good.ts` may hold a
 * suppression that is the point of the fixture. Neither is the repo's code, so
 * the overrides inventory and verify-diff skip them. Consumer repos are not
 * affected. package.json is read once, when the predicate is made.
 */
export function ruleFixtureFilter(root: string): (file: string) => boolean {
  if (!isPackageSource(root)) return () => false;
  const fixtures = resolve(root, "rules", "__fixtures__") + sep;
  return (file) => resolve(root, file).startsWith(fixtures);
}
