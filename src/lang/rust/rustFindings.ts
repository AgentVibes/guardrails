import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { match } from "ts-pattern";
import type { Finding } from "../../findings.js";
import { addedLinesByFile, changedFiles, RUST_PATHSPECS } from "../../gitDiff.js";
import type { Rung } from "../../verifyDiff.js";
import { type CargoRoot, cargoRoots } from "./cargoManifest.js";
import { type PlannedRun, planCargoRuns } from "./cargoPlan.js";
import { type CargoResult, runClippy, runFmtCheck, selectionArgs } from "./clippy.js";

// The Rust contribution to verify, verify-diff, hook-stop and snapshot:
// clippy and rustfmt over every Cargo root, findings with absolute paths,
// and the reason for every part that could not run.

export interface RustFindings {
  findings: Finding[];
  /** One line per check that could not run: `Cargo.toml clippy: the build failed …`. */
  unavailable: string[];
  /** .rs files in scope (-1 = the whole tree). */
  filesScanned: number;
}

export type RustRunMode = "verify" | "hook-stop" | "hook-postedit" | "snapshot";

const DEFAULT_TIMEOUT_S: Record<RustRunMode, number | undefined> = {
  verify: undefined,
  "hook-stop": 300,
  "hook-postedit": 90,
  snapshot: 900,
};

/** `GUARDRAILS_CLIPPY_TIMEOUT_S` wins; otherwise hooks and snapshot have a limit and CI runs do not. */
export function clippyTimeoutMs(mode: RustRunMode): number | undefined {
  const raw = process.env.GUARDRAILS_CLIPPY_TIMEOUT_S;
  const env = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const seconds = Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_S[mode];
  return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Snapshot writes nothing into the repo it observes: no Cargo.lock
 * (`--locked`) and, unless the environment names one, a target directory in
 * the user cache instead of `<repo>/target`.
 */
function snapshotEnv(cargoDir: string): Record<string, string> {
  if (process.env.CARGO_TARGET_DIR !== undefined && process.env.CARGO_TARGET_DIR !== "") return {};
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const key = createHash("sha256").update(cargoDir).digest("hex").slice(0, 16);
  return { CARGO_TARGET_DIR: join(cache, "agentvibes", "guardrails", "cargo-target", key) };
}

function label(r: CargoRoot): string {
  return r.rel === "" ? "Cargo.toml" : `${r.rel}/Cargo.toml`;
}

function collect(
  into: RustFindings,
  where: string,
  keep: (f: Finding) => boolean,
  result: CargoResult,
): void {
  match(result)
    .with({ status: "ran" }, (res) => {
      into.findings.push(...res.findings.filter(keep));
    })
    .with({ status: "unavailable" }, (res) => {
      into.unavailable.push(`${where}: ${res.reason}`);
    })
    .exhaustive();
}

/** `clippy` for the default run, `clippy (--workspace --exclude web)` for a configured one. */
function clippyLabel(r: CargoRoot, run: PlannedRun, configured: boolean): string {
  return configured
    ? `${label(r)} clippy (${selectionArgs(run.selection, run.target).join(" ")})`
    : `${label(r)} clippy`;
}

/**
 * clippy (once per planned run) + rustfmt over the given roots. Findings in
 * `[verify] exclude` paths and in members no run checks are dropped: cargo
 * still compiles them as dependencies, and rustfmt formats the whole root.
 */
export function runRustChecks(
  repoRoot: string,
  roots: readonly CargoRoot[],
  mode: RustRunMode,
): RustFindings {
  const plan = planCargoRuns(repoRoot, roots);
  const out: RustFindings = { findings: [], unavailable: [], filesScanned: -1 };
  for (const r of roots) {
    const rootPlan = plan.get(r);
    if (rootPlan === undefined) throw new Error(`no cargo plan for ${label(r)}`);
    const keep = (f: Finding): boolean => !rootPlan.dropped(f.file);
    const common = {
      timeoutMs: clippyTimeoutMs(mode),
      severity: mode === "snapshot" ? ("clippy-level" as const) : ("canon" as const),
      ...(mode === "snapshot" ? { env: snapshotEnv(r.manifest.dir), locked: true } : {}),
    };
    for (const run of rootPlan.runs) {
      collect(
        out,
        clippyLabel(r, run, rootPlan.configured),
        keep,
        runClippy(r.manifest.dir, repoRoot, { ...common, ...run }),
      );
    }
    collect(
      out,
      `${label(r)} rustfmt`,
      keep,
      runFmtCheck(r.manifest.dir, {
        ...common,
        selection: { kind: "workspace", exclude: [] },
        target: { kind: "host" },
      }),
    );
  }
  return out;
}

function inside(dir: string, file: string): boolean {
  return file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** The whole-repo Rust findings, for verify and snapshot. */
export function rustVerifyFindings(repoRoot: string, mode: "verify" | "snapshot"): RustFindings {
  const roots = cargoRoots(repoRoot);
  if (roots.length === 0) {
    return {
      findings: [],
      unavailable: ["Rust is enabled but there is no Cargo.toml in the checkout"],
      filesScanned: 0,
    };
  }
  return runRustChecks(repoRoot, roots, mode);
}

/**
 * The Rust side of the diff ratchet, on the same rungs as the TypeScript
 * side. Cargo runs only when a .rs file changed, and only for the roots that
 * hold one: a TypeScript-only diff in a mixed repo costs nothing.
 */
export function rustDiffFindings(
  cwd: string,
  rung: Rung,
  exclude: RegExp | undefined,
  mode: "verify" | "hook-stop",
): RustFindings {
  const roots = cargoRoots(cwd);
  const plan = match(rung)
    .with({ kind: "whole-tree" }, () => ({ files: undefined, keep: (_f: Finding) => true }))
    .with({ kind: "whole-file" }, ({ root }) => {
      const { tracked, untracked } = changedFiles(root, "HEAD", RUST_PATHSPECS);
      const files = new Set([...tracked, ...untracked]);
      return { files: [...files], keep: (f: Finding) => files.has(f.file) };
    })
    .with({ kind: "added-lines" }, ({ root, mergeBase }) => {
      const { tracked, untracked } = changedFiles(root, mergeBase, RUST_PATHSPECS);
      const fresh = new Set(untracked);
      const added = addedLinesByFile(root, mergeBase, RUST_PATHSPECS);
      return {
        files: [...new Set([...tracked, ...untracked])],
        keep: (f: Finding) => fresh.has(f.file) || (added.get(f.file)?.has(f.line) ?? false),
      };
    })
    .exhaustive();
  const excluded = (file: string): boolean => exclude?.test(relative(cwd, file)) === true;
  const files = plan.files?.filter((f) => !excluded(f));
  if (files !== undefined && files.length === 0)
    return { findings: [], unavailable: [], filesScanned: 0 };
  // A file in a member no run checks (`[[rust.cargo]]`) touches nothing:
  // clippy would not look at it, so running it would only cost time.
  const cargoPlan = planCargoRuns(cwd, roots);
  const checks = (r: CargoRoot, f: string): boolean =>
    inside(r.manifest.dir, f) && cargoPlan.get(r)?.dropped(f) === false;
  const touched =
    files === undefined ? roots : roots.filter((r) => files.some((f) => checks(r, f)));
  if (touched.length === 0)
    return { findings: [], unavailable: [], filesScanned: files?.length ?? 0 };
  const result = runRustChecks(cwd, touched, mode);
  return {
    findings: result.findings.filter((f) => !excluded(f.file)).filter(plan.keep),
    unavailable: result.unavailable,
    filesScanned: files?.length ?? -1,
  };
}
