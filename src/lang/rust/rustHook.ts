import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { match } from "ts-pattern";
import type { Finding } from "../../findings.js";
import { addedLines, gitRoot, RUST_PATHSPECS, resolveMergeBase } from "../../gitDiff.js";
import { OverrideConfigError } from "../../overrideDeclarations.js";
import { verifyExcludeRe } from "../../verifyExclude.js";
import { hasLanguage, resolveLanguages } from "../languages.js";
import type { CargoTarget } from "./cargoConfig.js";
import { type CargoRoot, cargoRoots, owningPackage } from "./cargoManifest.js";
import { planCargoRuns, type RootPlan } from "./cargoPlan.js";
import { runClippy } from "./clippy.js";
import { clippyTimeoutMs } from "./rustFindings.js";

// hook-postedit for a .rs file: clippy for the package that owns the file
// (`cargo clippy -p <name>`), within the hook time limit, filtered to the
// edited file and, when they can be computed, the lines the edit changed.
// The changed-lines ladder is the TypeScript hook's (hookPostedit.ts).
//
// Tooling problems never fail the edit: Rust not enabled, no owning package,
// a build that does not compile, a timeout. Each one is a `skip` with a note
// for stderr; CI's verify runs the same clippy and fails loudly there.

export type RustPostedit =
  | { status: "findings"; findings: Finding[] }
  | { status: "skip"; note: string | undefined };

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // ast-grep-ignore: catch-empty -- an unresolvable path keeps its spelling; the comparison below then fails closed (no findings matched)
    return path;
  }
}

function isTracked(root: string, file: string): boolean {
  const res = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", file], {
    encoding: "utf8",
  });
  return res.status === 0;
}

/** Lines this working tree added vs HEAD; undefined when the file is new (every line is). */
function newLines(root: string, file: string): Set<number> | undefined {
  return isTracked(root, file) ? addedLines(root, "HEAD", file, RUST_PATHSPECS) : undefined;
}

/** undefined = whole file; a Set = the lines changed vs merge-base(HEAD, base). */
function changedLines(tool: string, root: string, file: string): Set<number> | undefined {
  if (tool === "Write" || !isTracked(root, file)) return undefined;
  const mb = resolveMergeBase(root);
  return mb === undefined ? undefined : addedLines(root, mb, file, RUST_PATHSPECS);
}

function rustEnabled(root: string): { ok: true } | { ok: false; note: string | undefined } {
  try {
    return hasLanguage(resolveLanguages(root).languages, "rust")
      ? { ok: true }
      : { ok: false, note: undefined };
  } catch (err) {
    if (!(err instanceof OverrideConfigError)) throw err;
    return { ok: false, note: err.message };
  }
}

const HOST: CargoTarget = { kind: "host" };

/**
 * The target of the [[rust.cargo]] run that checks `name`. A package no run
 * checks is not checked by the hook either.
 */
function hookTarget(
  repoRoot: string,
  owner: CargoRoot,
  name: string,
): { status: "run"; target: CargoTarget } | { status: "skip"; note: string } {
  let plan: RootPlan | undefined;
  try {
    plan = planCargoRuns(repoRoot, [owner]).get(owner);
  } catch (err) {
    if (!(err instanceof OverrideConfigError)) throw err;
    return { status: "skip", note: err.message };
  }
  if (plan === undefined) throw new Error(`no cargo plan for ${owner.rel || "the repo root"}`);
  if (plan.unchecked.some((m) => m.packageName === name))
    return { status: "skip", note: `${name} is left out of every [[rust.cargo]] run` };
  const run = plan.runs.find((r) =>
    match(r.selection)
      .with({ kind: "workspace" }, (s) => !s.exclude.includes(name))
      .with({ kind: "packages" }, (s) => s.names.includes(name))
      .exhaustive(),
  );
  return { status: "run", target: run?.target ?? HOST };
}

export function rustPostedit(tool: string, editedFile: string): RustPostedit {
  const file = real(editedFile);
  const root = gitRoot(dirname(file));
  if (root === undefined) return { status: "skip", note: undefined };
  const repoRoot = real(root);
  const enabled = rustEnabled(repoRoot);
  if (!enabled.ok) return { status: "skip", note: enabled.note };
  // An edit inside `[verify] exclude` (a vendored crate) is not gated, as
  // for TypeScript: the crate is no Cargo root and clippy never checks it.
  let exclude: RegExp | undefined;
  try {
    exclude = verifyExcludeRe(repoRoot);
  } catch (err) {
    if (!(err instanceof OverrideConfigError)) throw err;
    return { status: "skip", note: err.message };
  }
  if (exclude?.test(relative(repoRoot, file).split(sep).join("/")) === true)
    return { status: "skip", note: undefined };
  const pkg = owningPackage(repoRoot, file);
  if (pkg?.packageName === undefined)
    return { status: "skip", note: `no Cargo package owns ${editedFile}` };
  // Cargo reports span paths relative to the workspace root, so clippy runs there.
  const name = pkg.packageName;
  const owner = cargoRoots(repoRoot).find(
    (r) => r.manifest.dir === pkg.dir || r.members.some((m) => m.dir === pkg.dir),
  );
  const cargoRoot = owner?.manifest.dir ?? pkg.dir;
  const picked =
    owner === undefined
      ? { status: "run" as const, target: HOST }
      : hookTarget(repoRoot, owner, name);
  if (picked.status === "skip") return picked;
  const target = picked.target;
  const result = runClippy(cargoRoot, repoRoot, {
    selection: { kind: "packages", names: [name] },
    target,
    severity: "canon",
    timeoutMs: clippyTimeoutMs("hook-postedit"),
  });
  return match(result)
    .with(
      { status: "unavailable" },
      (r): RustPostedit => ({
        status: "skip",
        note: `clippy -p ${pkg.packageName} could not run: ${r.reason}`,
      }),
    )
    .with({ status: "ran" }, (r): RustPostedit => {
      const lines = changedLines(tool, repoRoot, file);
      const inFile = r.findings.filter((f) => f.file === file);
      // An EMPTY set is a real answer (nothing of the edit's left to gate).
      if (lines !== undefined)
        return { status: "findings", findings: inFile.filter((f) => lines.has(f.line)) };
      // Whole file: a finding on a line this working tree did not add is
      // inherited and only warns, so a one-line fix in a legacy file is not
      // a mandatory clean-up of the whole file.
      const fresh = newLines(repoRoot, file);
      return {
        status: "findings",
        findings: inFile.map((f) =>
          fresh === undefined || fresh.has(f.line) ? f : { ...f, severity: "warning" as const },
        ),
      };
    })
    .exhaustive();
}
