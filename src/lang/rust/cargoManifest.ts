import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { collectFiles } from "../../fileWalk.js";
import { verifyExcludeRe } from "../../verifyExclude.js";

// Cargo.toml as guardrails reads it: TOML only, never `cargo metadata`, so
// detection, doctor and init cost nothing and work without a toolchain.

/** Directories whose Cargo.toml files are not the project's crates. */
const SKIP_SEGMENTS = new Set([
  "node_modules",
  "target",
  ".git",
  "fixtures",
  "testdata",
  "test-fixtures",
]);

const Table = z.record(z.string(), z.unknown());

const ManifestDoc = z
  .object({
    package: z
      .object({ name: z.string().default("") })
      .loose()
      .optional(),
    workspace: z
      .object({
        members: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
        lints: z.record(z.string(), Table).optional(),
      })
      .loose()
      .optional(),
    lints: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export type Manifest = {
  /** Absolute path of the Cargo.toml. */
  path: string;
  /** Absolute directory holding it. */
  dir: string;
  /** Repo-relative directory, "" for the repo root. */
  rel: string;
  packageName: string | undefined;
  workspace:
    | { kind: "none" }
    | {
        kind: "workspace";
        members: string[];
        exclude: string[];
        /** `[workspace.lints.<tool>]`, by tool. */
        lints: Record<string, Record<string, unknown>> | undefined;
      };
  /** `[lints]`: inherited from the workspace, the crate's own tables, or absent. */
  lints:
    | { kind: "absent" }
    | { kind: "inherits" }
    | { kind: "own"; tables: Record<string, Record<string, unknown>> };
};

export class CargoManifestError extends Error {}

function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function readManifest(root: string, path: string): Manifest {
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CargoManifestError(
      `${relPath(root, path)} is not valid TOML: ${(e as Error).message.split("\n")[0]}`,
    );
  }
  const parsed = ManifestDoc.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CargoManifestError(
      `${relPath(root, path)}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`,
    );
  }
  const doc = parsed.data;
  const lints = doc.lints;
  const ownTables: Record<string, Record<string, unknown>> = {};
  for (const [tool, body] of Object.entries(lints ?? {})) {
    const t = Table.safeParse(body);
    if (t.success) ownTables[tool] = t.data;
  }
  const dir = dirname(path);
  return {
    path,
    dir,
    rel: relPath(root, dir),
    packageName: doc.package === undefined ? undefined : doc.package.name || undefined,
    workspace:
      doc.workspace === undefined
        ? { kind: "none" }
        : {
            kind: "workspace",
            members: doc.workspace.members,
            exclude: doc.workspace.exclude,
            lints: doc.workspace.lints,
          },
    lints:
      lints === undefined
        ? { kind: "absent" }
        : lints.workspace === true
          ? { kind: "inherits" }
          : { kind: "own", tables: ownTables },
  };
}

function skipped(rel: string): boolean {
  return rel.split("/").some((s) => SKIP_SEGMENTS.has(s));
}

/** Every Cargo.toml in the checkout, absolute: git's view (tracked + untracked, not ignored) when there is one. */
function manifestPaths(root: string): string[] {
  const res = spawnSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "Cargo.toml",
      "*/Cargo.toml",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const listed =
    !res.error && res.status === 0
      ? res.stdout
          .split("\0")
          .filter((f) => f !== "")
          .map((f) => join(root, f))
      : collectFiles([root], ["/Cargo.toml"]).concat(
          existsSync(join(root, "Cargo.toml")) ? [join(root, "Cargo.toml")] : [],
        );
  return [...new Set(listed)].filter((p) => existsSync(p) && !skipped(relPath(root, p))).sort();
}

function globToRegExp(segment: string): RegExp {
  const body = segment
    .split("")
    .map((ch) =>
      ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

/** Expands `members` globs (`crates/*`, `crates/core/*`) to member directories that hold a Cargo.toml. */
export function memberDirs(ws: Manifest): string[] {
  if (ws.workspace.kind === "none") return [];
  const { members, exclude } = ws.workspace;
  const excluded = exclude.map((e) => join(ws.dir, e));
  const out = new Set<string>();
  for (const pattern of members) {
    let dirs = [ws.dir];
    for (const segment of pattern.split("/").filter((s) => s !== "" && s !== ".")) {
      if (!/[*?]/.test(segment)) {
        dirs = dirs.map((d) => join(d, segment));
        continue;
      }
      const re = globToRegExp(segment);
      dirs = dirs.flatMap((d) => {
        if (!existsSync(d)) return [];
        return readdirSync(d)
          .filter((name) => re.test(name))
          .map((name) => join(d, name))
          .filter((p) => statSync(p).isDirectory());
      });
    }
    for (const d of dirs) {
      if (!existsSync(join(d, "Cargo.toml"))) continue;
      if (excluded.some((e) => d === e || d.startsWith(e + sep))) continue;
      out.add(d);
    }
  }
  out.delete(ws.dir);
  return [...out].sort();
}

/** A Cargo root: a workspace with its members, or a crate that belongs to no workspace. */
export interface CargoRoot {
  manifest: Manifest;
  /** Repo-relative directory, "" for the repo root. */
  rel: string;
  /** Member crates (not the root itself), in directory order; `[verify] exclude` ones left out. */
  members: Manifest[];
  /** Members under `[verify] exclude` (vendored): never checked, so clippy runs `--exclude` them. */
  vendored: Manifest[];
}

/** `Cargo.toml`, `crates/a/Cargo.toml`: the path `[verify] exclude` is tested against. */
export function manifestRelPath(m: Manifest): string {
  return m.rel === "" ? "Cargo.toml" : `${m.rel}/Cargo.toml`;
}

/**
 * The Cargo roots of a checkout. A manifest that cannot be parsed is skipped
 * here (detection must not throw) and reported by the wiring checks, which
 * read it again. A manifest under `[verify] exclude` (a vendored tree) is
 * not the project's: it is no root, and a workspace member there is listed
 * in `vendored` instead of `members`. Throws OverrideConfigError when the
 * exclude is not a regular expression.
 */
export function cargoRoots(root: string): CargoRoot[] {
  const manifests: Manifest[] = [];
  for (const path of manifestPaths(root)) {
    try {
      manifests.push(readManifest(root, path));
    } catch (err) {
      if (!(err instanceof CargoManifestError)) throw err;
    }
  }
  const exclude = verifyExcludeRe(root);
  const excluded = (m: Manifest): boolean => exclude?.test(manifestRelPath(m)) === true;
  // Every workspace, vendored ones too: a crate inside a vendored workspace
  // belongs to it, not to the project as a root of its own.
  const workspaces = manifests.filter((m) => m.workspace.kind === "workspace");
  const inside = (m: Manifest, ws: Manifest): boolean =>
    m.dir === ws.dir || m.dir.startsWith(ws.dir + sep);
  const roots: CargoRoot[] = workspaces
    .filter((ws) => !excluded(ws))
    .map((ws) => {
      const dirs = new Set(memberDirs(ws));
      const all = manifests.filter((m) => dirs.has(m.dir));
      return {
        manifest: ws,
        rel: ws.rel,
        members: all.filter((m) => !excluded(m)),
        vendored: all.filter(excluded),
      };
    });
  for (const m of manifests) {
    if (m.workspace.kind === "workspace") continue;
    if (workspaces.some((ws) => inside(m, ws))) continue;
    if (m.packageName === undefined || excluded(m)) continue;
    roots.push({ manifest: m, rel: m.rel, members: [], vendored: [] });
  }
  return roots.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The nearest manifest with a `[package]` at or above `file`'s directory, stopping at `root`. */
export function owningPackage(root: string, file: string): Manifest | undefined {
  let dir = dirname(file);
  for (;;) {
    const path = join(dir, "Cargo.toml");
    if (existsSync(path)) {
      try {
        const m = readManifest(root, path);
        if (m.packageName !== undefined) return m;
      } catch (err) {
        if (!(err instanceof CargoManifestError)) throw err;
        return undefined;
      }
    }
    if (dir === root || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}
