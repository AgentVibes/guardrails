import { relative, sep } from "node:path";
import { match } from "ts-pattern";
import { OverrideConfigError } from "../../overrideDeclarations.js";
import { verifyExcludeRe } from "../../verifyExclude.js";
import { type CargoSelection, type CargoTarget, readCargoRuns } from "./cargoConfig.js";
import { type CargoRoot, cargoRoots, type Manifest } from "./cargoManifest.js";

// Which clippy runs a Cargo root gets, from `[[rust.cargo]]` (cargoConfig.ts)
// and `[verify] exclude`: the selection and target of each run, the members
// no run checks, and which files' findings are not the project's.

export interface PlannedRun {
  selection: CargoSelection;
  target: CargoTarget;
}

export interface RootPlan {
  runs: PlannedRun[];
  /** The runs come from `[[rust.cargo]]`, not the default. */
  configured: boolean;
  /** Members (or the root package) that no run checks. */
  unchecked: Manifest[];
  /** A file under `[verify] exclude`, or inside a member no run checks. */
  dropped: (absFile: string) => boolean;
}

function crates(r: CargoRoot): Manifest[] {
  return [...(r.manifest.packageName === undefined ? [] : [r.manifest]), ...r.members];
}

function names(ms: readonly Manifest[]): string[] {
  return ms.flatMap((m) => (m.packageName === undefined ? [] : [m.packageName]));
}

function under(dir: string, file: string): boolean {
  return file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function where(r: CargoRoot): string {
  return r.rel === "" ? '"."' : `"${r.rel}"`;
}

/**
 * The clippy runs of every root in `roots`. Throws OverrideConfigError when
 * an entry names a root or a package that does not exist: a run the gate
 * cannot honour must fail loudly, not check less than it says.
 */
export function planCargoRuns(
  repoRoot: string,
  roots: readonly CargoRoot[],
): Map<CargoRoot, RootPlan> {
  const configured = readCargoRuns(repoRoot);
  const exclude = verifyExcludeRe(repoRoot);
  if (configured.length > 0) {
    const all = cargoRoots(repoRoot);
    for (const run of configured) {
      const r = all.find((x) => x.rel === run.root);
      if (r === undefined) {
        throw new OverrideConfigError(
          `.agentvibes/project.toml: ${run.label} root = "${run.root || "."}" is not a Cargo root (roots: ${all.map(where).join(", ") || "none"})`,
        );
      }
      const known = new Set([...names(crates(r)), ...names(r.vendored)]);
      const listed = match(run.selection)
        .with({ kind: "workspace" }, (s) => s.exclude)
        .with({ kind: "packages" }, (s) => s.names)
        .exhaustive();
      const unknown = listed.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        throw new OverrideConfigError(
          `.agentvibes/project.toml: ${run.label} (root ${where(r)}) names ${unknown.join(", ")}, not a package of that root (packages: ${[...known].join(", ") || "none"})`,
        );
      }
    }
  }
  const out = new Map<CargoRoot, RootPlan>();
  for (const r of roots) {
    const vendored = new Set(names(r.vendored));
    const own = configured.filter((c) => c.root === r.rel);
    const entries: PlannedRun[] =
      own.length > 0
        ? own
        : [{ selection: { kind: "workspace", exclude: [] }, target: { kind: "host" } }];
    const runs: PlannedRun[] = entries.flatMap((e): PlannedRun[] =>
      match(e.selection)
        .with({ kind: "workspace" }, (s): PlannedRun[] => [
          {
            target: e.target,
            selection: {
              kind: "workspace",
              exclude: [...new Set([...s.exclude, ...vendored])],
            },
          },
        ])
        .with({ kind: "packages" }, (s): PlannedRun[] => {
          const kept = s.names.filter((n) => !vendored.has(n));
          return kept.length === 0
            ? []
            : [{ target: e.target, selection: { kind: "packages", names: kept } }];
        })
        .exhaustive(),
    );
    const checked = new Set(
      runs.flatMap((run) =>
        match(run.selection)
          .with({ kind: "workspace" }, (s) =>
            names(crates(r)).filter((n) => !s.exclude.includes(n)),
          )
          .with({ kind: "packages" }, (s) => s.names)
          .exhaustive(),
      ),
    );
    const unchecked = crates(r).filter(
      (m) => m.packageName !== undefined && !checked.has(m.packageName),
    );
    // The root package's directory holds the members: only a member's own
    // directory is dropped, never the whole root.
    const droppedDirs = [...unchecked.filter((m) => m !== r.manifest), ...r.vendored].map(
      (m) => m.dir,
    );
    const rootUnchecked = unchecked.includes(r.manifest);
    const memberDirs = r.members.map((m) => m.dir);
    out.set(r, {
      runs,
      configured: own.length > 0,
      unchecked,
      dropped: (file) => {
        if (exclude?.test(relative(repoRoot, file).split(sep).join("/")) === true) return true;
        if (droppedDirs.some((d) => under(d, file))) return true;
        return (
          rootUnchecked && under(r.manifest.dir, file) && !memberDirs.some((d) => under(d, file))
        );
      },
    });
  }
  return out;
}
