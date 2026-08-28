import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// Workspace enumeration for stack detection. In a monorepo the root
// package.json is dependency-empty — the stack signals (mobx, vite, expo,
// tailwind…) live in the workspace packages, so init must read them all
// (observatory adoption: root-only detection produced state=none for a mobx
// repo). Sources: pnpm-workspace.yaml `packages:` globs, or package.json
// `workspaces` (array or { packages }).

export interface WorkspacePackage {
  name: string;
  dir: string;
  deps: Record<string, string>;
}

function workspaceGlobs(cwd: string): string[] {
  const pnpmPath = join(cwd, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    const globs: string[] = [];
    let inPackages = false;
    for (const raw of readFileSync(pnpmPath, "utf8").split("\n")) {
      const line = raw.replace(/#.*$/, "").trimEnd();
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s+-\s+["']?([^"']+)["']?\s*$/);
        if (m?.[1] !== undefined) globs.push(m[1]);
        else if (!/^\s/.test(line) && line !== "") inPackages = false;
      }
    }
    if (globs.length > 0) return globs;
  }
  const pkgPath = join(cwd, "package.json");
  // ast-grep-ignore: silent-default-return -- no package.json means no workspaces to enumerate; the caller falls back to root-only detection
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  return pkg.workspaces?.packages ?? [];
}

/** Expand a workspace glob. Supports literal dirs and a trailing `*` segment (`packages/*`). */
function expandGlob(cwd: string, glob: string): string[] {
  const clean = glob.replace(/\/$/, "");
  if (clean.startsWith("!")) return [];
  if (!clean.includes("*")) return [join(cwd, clean)];
  const starAt = clean.indexOf("*");
  const parent = join(cwd, clean.slice(0, starAt).replace(/\/$/, ""));
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries
    .map((e) => join(parent, e))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

export function listWorkspacePackages(cwd: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const glob of workspaceGlobs(cwd)) {
    for (const dir of expandGlob(cwd, glob)) {
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      let pkg: {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg;
      } catch {
        continue;
      }
      out.push({
        name: pkg.name ?? basename(dir),
        dir,
        deps: { ...pkg.dependencies, ...pkg.devDependencies },
      });
    }
  }
  return out;
}
