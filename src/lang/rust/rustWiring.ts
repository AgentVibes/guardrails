import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import { OverrideConfigError } from "../../overrideDeclarations.js";
import type { WiringCheck } from "../../wiring.js";
import {
  CargoManifestError,
  type CargoRoot,
  cargoRoots,
  type Manifest,
  readManifest,
} from "./cargoManifest.js";
import { planCargoRuns } from "./cargoPlan.js";
import { canonLints, compareLints, type LintTables, parseLintTables } from "./lintTable.js";

// The Rust wiring checks. Each reads files only (TOML, CI configs) and
// answers pass/fail with the evidence, like the TypeScript checks in
// wiring.ts. Ids are prefixed by the adapter: `rust.clippy-strict`.

export const RUST_WIRING_CHECKS = [
  "rust.clippy-strict",
  "rust.lints-inherited",
  "rust.toolchain",
  "rust.ci",
] as const;
export type RustWiringCheckId = (typeof RUST_WIRING_CHECKS)[number];

/**
 * Checks that say nothing about whether guardrails runs here: a toolchain
 * file and inherited lints are good hygiene in any Rust repo. They still
 * keep a repo from `on`, but alone they do not make it `partial`.
 */
export const NEUTRAL_RUST_CHECKS: ReadonlySet<string> = new Set([
  "rust.toolchain",
  "rust.lints-inherited",
]);

function pass(id: RustWiringCheckId, detail: string): WiringCheck {
  return { id, status: "pass", detail };
}
function fail(id: RustWiringCheckId, detail: string): WiringCheck {
  return { id, status: "fail", detail };
}

function where(r: CargoRoot): string {
  return r.rel === "" ? "Cargo.toml" : `${r.rel}/Cargo.toml`;
}

/** The lint table that governs a root: `[workspace.lints]` for a workspace, `[lints]` for a single crate. */
export function governingLints(r: CargoRoot):
  | {
      status: "set";
      prefix: "workspace.lints" | "lints";
      raw: Record<string, Record<string, unknown>>;
    }
  | { status: "absent"; prefix: "workspace.lints" | "lints" } {
  const m = r.manifest;
  return match(m.workspace)
    .with({ kind: "workspace" }, (ws) =>
      ws.lints === undefined
        ? { status: "absent" as const, prefix: "workspace.lints" as const }
        : { status: "set" as const, prefix: "workspace.lints" as const, raw: ws.lints },
    )
    .with({ kind: "none" }, () =>
      match(m.lints)
        .with({ kind: "own" }, (l) => ({
          status: "set" as const,
          prefix: "lints" as const,
          raw: l.tables,
        }))
        .with({ kind: "absent" }, { kind: "inherits" }, () => ({
          status: "absent" as const,
          prefix: "lints" as const,
        }))
        .exhaustive(),
    )
    .exhaustive();
}

const SHOWN_GAPS = 6;

/**
 * A workspace may carry the canon in each crate's own `[lints]` instead of
 * `[workspace.lints]`. That counts when every crate clippy checks (members
 * under `[verify] exclude` or left out of every `[[rust.cargo]]` run do not
 * count) has its own table and each one meets the canon.
 */
function perCrateCanon(
  r: CargoRoot,
  checked: readonly Manifest[],
  canon: LintTables,
): { ok: true; detail: string } | { ok: false } {
  if (r.manifest.workspace.kind === "none" || checked.length === 0) return { ok: false };
  const meets = checked.every((m) =>
    match(m.lints)
      .with({ kind: "own" }, (l) => {
        const { tables, problems } = parseLintTables(l.tables);
        return problems.length === 0 && compareLints(tables, canon).gaps.length === 0;
      })
      .with({ kind: "absent" }, { kind: "inherits" }, () => false)
      .exhaustive(),
  );
  if (!meets) return { ok: false };
  return {
    ok: true,
    detail: `${where(r)}: every checked crate's own [lints] meets the canon (${checked.length} crate(s): ${checked
      .map((m) => m.rel || ".")
      .slice(0, SHOWN_GAPS)
      .join(", ")}${checked.length > SHOWN_GAPS ? ", …" : ""})`,
  };
}

function strictFor(
  r: CargoRoot,
  checked: readonly Manifest[],
  canon: LintTables,
): { ok: boolean; detail: string } {
  const governed = strictForGoverning(r, canon);
  if (governed.ok) return governed;
  const per = perCrateCanon(r, checked, canon);
  return per.ok ? per : governed;
}

function strictForGoverning(r: CargoRoot, canon: LintTables): { ok: boolean; detail: string } {
  const lints = governingLints(r);
  return match(lints)
    .with({ status: "absent" }, (l) => ({
      ok: false,
      detail: `${where(r)} has no [${l.prefix}.clippy] table (guardrails init writes the canon)`,
    }))
    .with({ status: "set" }, (l) => {
      const { tables, problems } = parseLintTables(l.raw);
      const { gaps } = compareLints(tables, canon);
      const all = [...problems.map((p) => `${p.tool}.${p.name}: ${p.message}`), ...gaps];
      if (all.length === 0) {
        const n = Object.values(canon).reduce((s, t) => s + Object.keys(t).length, 0);
        return { ok: true, detail: `${where(r)} [${l.prefix}] meets the canon (${n} entries)` };
      }
      const more = all.length > SHOWN_GAPS ? `; … ${all.length - SHOWN_GAPS} more` : "";
      return {
        ok: false,
        detail: `${where(r)} [${l.prefix}]: ${all.slice(0, SHOWN_GAPS).join("; ")}${more}`,
      };
    })
    .exhaustive();
}

function inheritedFor(
  r: CargoRoot,
  checked: readonly Manifest[],
  canon: LintTables,
): { ok: boolean; detail: string } {
  if (r.manifest.workspace.kind === "none")
    return { ok: true, detail: `${where(r)} is a single crate; its own [lints] table applies` };
  // No [workspace.lints] to inherit, and every crate carries the canon itself.
  if (governingLints(r).status === "absent") {
    const per = perCrateCanon(r, checked, canon);
    if (per.ok) return { ok: true, detail: `${per.detail}; nothing to inherit` };
  }
  const crates = [...(r.manifest.packageName === undefined ? [] : [r.manifest]), ...r.members];
  const missing = crates.filter((m) => m.lints.kind !== "inherits");
  if (missing.length === 0)
    return {
      ok: true,
      detail: `${where(r)}: all ${crates.length} crate(s) set [lints] workspace = true`,
    };
  return {
    ok: false,
    detail: `${where(r)}: ${missing.length} of ${crates.length} crate(s) do not set [lints] workspace = true: ${missing
      .map((m) => m.rel || ".")
      .slice(0, SHOWN_GAPS)
      .join(", ")}${missing.length > SHOWN_GAPS ? ", …" : ""}`,
  };
}

function toolchainFor(root: string, r: CargoRoot): { ok: boolean; detail: string } {
  const dirs = [...new Set([r.manifest.dir, root])];
  for (const d of dirs) {
    for (const f of ["rust-toolchain.toml", "rust-toolchain"]) {
      if (existsSync(join(d, f))) {
        const rel = d === root ? f : `${r.rel}/${f}`;
        return { ok: true, detail: `${rel} pins the toolchain` };
      }
    }
  }
  return { ok: false, detail: `no rust-toolchain.toml next to ${where(r)} or at the repo root` };
}

const VERIFY_RUNS = /\bguardrails\s+(?:verify|verify-diff)\b/;
const CLIPPY_STRICT = /\bcargo\s+(?:\+\S+\s+)?clippy\b[^\n]*-D\s*warnings/;
const CLIPPY_ANY = /\bcargo\s+(?:\+\S+\s+)?clippy\b/;
const RUSTFLAGS_DENY = /RUSTFLAGS\s*[:=]\s*["']?[^\n]*-D\s*warnings/;
const FMT_CHECK = /\bcargo\s+(?:\+\S+\s+)?fmt\b[^\n]*--check/;
const REUSABLE_GATE = /agentvibes\/guardrails\/\.github\/workflows\/guardrails-gate\.ya?ml/i;
/** A file a CI step runs: `scripts/ci.sh`, `./tools/check.ts`. */
const FILE_CALL = /(?:^|\s)(\.?\.?\/?[\w./-]+\.(?:sh|mjs|cjs|js|ts))\b/g;
const SCRIPT_CALL = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g;

/** A CI file's text plus what it runs, one level deep: script files, `just`/`make` recipes, package scripts. */
function withCalls(root: string, text: string): string {
  const parts = [text];
  for (const [, file] of text.matchAll(FILE_CALL)) {
    if (file === undefined) continue;
    const path = join(root, file);
    if (existsSync(path)) parts.push(readFileSync(path, "utf8"));
  }
  if (/\bjust\b/.test(text)) {
    for (const f of ["justfile", "Justfile", ".justfile"]) {
      if (existsSync(join(root, f))) parts.push(readFileSync(join(root, f), "utf8"));
    }
  }
  if (/\bmake\b/.test(text) && existsSync(join(root, "Makefile")))
    parts.push(readFileSync(join(root, "Makefile"), "utf8"));
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: unknown };
      if (typeof pkg.scripts === "object" && pkg.scripts !== null)
        scripts = pkg.scripts as Record<string, string>;
    } catch {
      // ast-grep-ignore: catch-empty -- an unreadable package.json is reported by the TypeScript checks; here it only means no package scripts to follow
      scripts = {};
    }
    for (const [, name] of text.matchAll(SCRIPT_CALL)) {
      const body = name === undefined ? undefined : scripts[name];
      if (typeof body === "string") parts.push(body);
    }
  }
  return parts.join("\n");
}

function checkRustCi(root: string, files: readonly string[]): WiringCheck {
  if (files.length === 0)
    return fail("rust.ci", "no CI config (.github/workflows, .gitea/workflows, .gitlab-ci.yml)");
  const partial: string[] = [];
  for (const f of files) {
    const text = withCalls(root, readFileSync(join(root, f), "utf8"));
    if (REUSABLE_GATE.test(text)) return pass("rust.ci", `${f} uses the reusable guardrails gate`);
    if (VERIFY_RUNS.test(text))
      return pass("rust.ci", `${f} runs guardrails verify, which runs clippy and rustfmt`);
    const clippy = CLIPPY_STRICT.test(text) || (CLIPPY_ANY.test(text) && RUSTFLAGS_DENY.test(text));
    const fmt = FMT_CHECK.test(text);
    if (clippy && fmt)
      return pass("rust.ci", `${f} runs cargo clippy with -D warnings and cargo fmt --check`);
    if (clippy) partial.push(`${f} runs clippy -D warnings but not cargo fmt --check`);
    else if (fmt) partial.push(`${f} runs cargo fmt --check but not clippy -D warnings`);
    else if (CLIPPY_ANY.test(text)) partial.push(`${f} runs cargo clippy without -D warnings`);
  }
  return fail(
    "rust.ci",
    partial.length > 0
      ? partial.join("; ")
      : `none of ${files.join(", ")} runs cargo clippy -D warnings + cargo fmt --check, or guardrails verify`,
  );
}

function perRoot(
  id: RustWiringCheckId,
  roots: CargoRoot[],
  one: (r: CargoRoot) => { ok: boolean; detail: string },
): WiringCheck {
  const results = roots.map(one);
  const detail = results.map((r) => r.detail).join(" | ");
  return results.every((r) => r.ok) ? pass(id, detail) : fail(id, detail);
}

/** Every Rust wiring check for `root`, in RUST_WIRING_CHECKS order. `ciFiles` are repo-relative CI configs. */
export function rustWiringChecks(root: string, ciFiles: readonly string[]): WiringCheck[] {
  let roots: CargoRoot[];
  let plan: ReturnType<typeof planCargoRuns>;
  try {
    roots = cargoRoots(root);
    // cargoRoots skips manifests it cannot parse; a broken root manifest must fail loudly here.
    for (const r of roots) readManifest(root, r.manifest.path);
    plan = planCargoRuns(root, roots);
  } catch (err) {
    if (!(err instanceof CargoManifestError) && !(err instanceof OverrideConfigError)) throw err;
    return RUST_WIRING_CHECKS.map((id) => fail(id, err.message));
  }
  if (roots.length === 0) {
    return RUST_WIRING_CHECKS.map((id) =>
      fail(id, "Rust is enabled but there is no Cargo.toml in the checkout"),
    );
  }
  const canon = canonLints();
  const checked = (r: CargoRoot): Manifest[] => {
    const unchecked = plan.get(r)?.unchecked ?? [];
    return [...(r.manifest.packageName === undefined ? [] : [r.manifest]), ...r.members].filter(
      (m) => !unchecked.includes(m),
    );
  };
  return [
    perRoot("rust.clippy-strict", roots, (r) => strictFor(r, checked(r), canon)),
    perRoot("rust.lints-inherited", roots, (r) => inheritedFor(r, checked(r), canon)),
    perRoot("rust.toolchain", roots, (r) => toolchainFor(root, r)),
    checkRustCi(root, ciFiles),
  ];
}
