import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/packagePaths.js sits one level under the package root.
export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const rulesConfig = join(packageRoot, "sgconfig.yml");
export const structureConfig = join(packageRoot, "structure", "sgconfig.yml");
export const rulesDir = join(packageRoot, "rules");
export const structureRulesDir = join(packageRoot, "structure", "rules");
export const fixturesDir = join(packageRoot, "rules", "__fixtures__");
export const miseToml = join(packageRoot, "mise.toml");
