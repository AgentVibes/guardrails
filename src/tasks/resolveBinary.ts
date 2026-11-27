import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pinnedVersion, tryResolveTool } from "../toolResolve.js";

export interface PackageMeta {
  name?: string;
  main?: string;
  exports?: unknown;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  allDeps: Record<string, string>;
}

/** Reads `package.json` from `root` if present and valid; returns undefined otherwise. */
export function readRootPackage(root: string): PackageMeta | undefined {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: unknown;
      main?: unknown;
      exports?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = raw.dependencies ?? {};
    const devDependencies = raw.devDependencies ?? {};
    return {
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(typeof raw.main === "string" ? { main: raw.main } : {}),
      ...(raw.exports !== undefined ? { exports: raw.exports } : {}),
      dependencies,
      devDependencies,
      allDeps: { ...dependencies, ...devDependencies },
    };
  } catch {
    return undefined;
  }
}

/** Checks if any of `names` exists directly in `root`. */
export function hasAnyFile(root: string, names: readonly string[]): string | undefined {
  return names.find((n) => existsSync(join(root, n)));
}

function isExecutable(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds `<dir>/node_modules/.bin/<binary>` walking up from `root`. */
export function findLocalBin(root: string, binary: string): string | undefined {
  let dir = resolve(root);
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", binary);
    if (isExecutable(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Finds `<binary>` in `PATH`. */
export function findOnPath(binary: string, envPath = process.env.PATH ?? ""): string | undefined {
  for (const dir of envPath.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export interface ResolvedBinary {
  /** Argv prefix to invoke the binary (e.g. `["/path/to/biome"]` or `["mise", "x", "biome@2.5.10", "--", "biome"]`). */
  prefix: string[];
  via: "local" | "path" | "mise";
}

/**
 * Resolves a task binary: `node_modules/.bin` (walking up from `root`) first,
 * then `PATH`, then `mise x <tool>@<pin>` for tools pinned in `mise.toml`.
 */
export function resolveBinary(root: string, binary: string): ResolvedBinary | undefined {
  const local = findLocalBin(root, binary);
  if (local !== undefined) return { prefix: [local], via: "local" };

  const onPath = findOnPath(binary);
  if (onPath !== undefined) return { prefix: [onPath], via: "path" };

  if (pinnedVersion(binary) !== undefined) {
    const viaMise = tryResolveTool(binary);
    if (viaMise !== undefined) return { prefix: viaMise.argv, via: "mise" };
  }
  return undefined;
}

export function hasBinary(root: string, binary: string): boolean {
  return resolveBinary(root, binary) !== undefined;
}

/**
 * Reads an installed package's `version` from `node_modules/<pkg>/package.json`,
 * walking up from `root`. Returns undefined if not installed.
 */
export function installedPackageVersion(root: string, pkgName: string): string | undefined {
  let dir = resolve(root);
  for (;;) {
    const candidate = join(dir, "node_modules", pkgName, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string") return parsed.version;
      } catch (err) {
        console.warn(`guardrails: ignoring unreadable ${candidate}: ${(err as Error).message}`);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Extracts the leading major version integer from a semver string or range (e.g. `"^7.0.2"` → 7). */
export function parseMajorVersion(spec: string): number | undefined {
  const m = spec.trim().match(/(\d+)\.\d+/);
  if (m?.[1] !== undefined) return Number(m[1]);
  const single = spec.trim().match(/^[~^>=<\s]*(\d+)$/);
  return single?.[1] !== undefined ? Number(single[1]) : undefined;
}
