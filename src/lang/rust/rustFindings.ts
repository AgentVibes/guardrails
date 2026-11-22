import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { match } from "ts-pattern";
import type { Finding } from "../../findings.js";
import { addedLinesByFile, changedFiles, RUST_PATHSPECS } from "../../gitDiff.js";
import type { Rung } from "../../verifyDiff.js";
import { type CargoRoot, cargoRoots } from "./cargoManifest.js";
import { type CargoOptions, type CargoResult, runClippy, runFmtCheck } from "./clippy.js";

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

function optionsFor(mode: RustRunMode, cargoDir: string, pkg?: string): CargoOptions {
  return {
    package: pkg,
    timeoutMs: clippyTimeoutMs(mode),
    ...(mode === "snapshot" ? { env: snapshotEnv(cargoDir), locked: true } : {}),
  };
}

function label(r: CargoRoot): string {
  return r.rel === "" ? "Cargo.toml" : `${r.rel}/Cargo.toml`;
}

function collect(
  into: RustFindings,
  r: CargoRoot,
  check: "clippy" | "rustfmt",
  result: CargoResult,
): void {
  match(result)
    .with({ status: "ran" }, (res) => {
      into.findings.push(...res.findings);
    })
    .with({ status: "unavailable" }, (res) => {
      into.unavailable.push(`${label(r)} ${check}: ${res.reason}`);
    })
    .exhaustive();
}

/** clippy + rustfmt over the given roots. */
export function runRustChecks(
  repoRoot: string,
  roots: readonly CargoRoot[],
  mode: RustRunMode,
): RustFindings {
  const out: RustFindings = { findings: [], unavailable: [], filesScanned: -1 };
  for (const r of roots) {
    const opts = optionsFor(mode, r.manifest.dir);
    collect(out, r, "clippy", runClippy(r.manifest.dir, repoRoot, opts));
    collect(out, r, "rustfmt", runFmtCheck(r.manifest.dir, opts));
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
  const touched =
    files === undefined ? roots : roots.filter((r) => files.some((f) => inside(r.manifest.dir, f)));
  if (touched.length === 0)
    return { findings: [], unavailable: [], filesScanned: files?.length ?? 0 };
  const result = runRustChecks(cwd, touched, mode);
  return {
    findings: result.findings.filter((f) => !excluded(f.file)).filter(plan.keep),
    unavailable: result.unavailable,
    filesScanned: files?.length ?? -1,
  };
}
