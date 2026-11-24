import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { OverrideConfigError } from "../../overrideDeclarations.js";

// How clippy runs in each Cargo root, from `[[rust.cargo]]` in
// .agentvibes/project.toml. Absent = one host run of
// `cargo clippy --workspace` per root, as before.
//
//   [[rust.cargo]]
//   root = "."                       # the Cargo root, repo-relative ("." = repo root)
//   exclude_packages = ["web"]       # `--workspace --exclude web`
//
//   [[rust.cargo]]
//   root = "."
//   target = "wasm32-unknown-unknown"  # `--target …`; "host" (default) = no --target
//   packages = ["web"]                 # `-p web` instead of `--workspace`
//
// Several entries for one root are several clippy runs. A member that no run
// of its root checks is not checked at all; the overrides inventory lists it
// (verify-scope `rust.cargo`), so it needs a written reason like any other
// weakening of the canon.

export const CARGO_CONFIG_KEY = "rust.cargo";

const Entry = z
  .object({
    root: z.string().min(1).default("."),
    /** A target triple, or "host" (the default): the toolchain's own target, no `--target`. */
    target: z.string().min(1).default("host"),
    packages: z.array(z.string().min(1)).default([]),
    exclude_packages: z.array(z.string().min(1)).default([]),
  })
  .strict();

const RustTable = z.object({ cargo: z.array(Entry).default([]) }).loose();

/** Which packages one clippy run selects. */
export type CargoSelection =
  | { kind: "workspace"; exclude: string[] }
  | { kind: "packages"; names: string[] };

export type CargoTarget = { kind: "host" } | { kind: "triple"; triple: string };

export interface CargoRun {
  /** Repo-relative Cargo root, "" for the repo root. */
  root: string;
  target: CargoTarget;
  selection: CargoSelection;
  /** `[[rust.cargo]] #n`, for messages. */
  label: string;
}

function normRoot(root: string): string {
  const r = root
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  return r === "." ? "" : r;
}

/** Every `[[rust.cargo]]` entry, in file order. Throws OverrideConfigError when malformed. */
export function readCargoRuns(repoRoot: string): CargoRun[] {
  const path = join(repoRoot, ".agentvibes", "project.toml");
  // ast-grep-ignore: silent-default-return -- no project file means no [[rust.cargo]]; every root then gets the default run
  if (!existsSync(path)) return [];
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new OverrideConfigError(
      `${path} is not valid TOML: ${(e as Error).message.split("\n")[0]}`,
    );
  }
  // ast-grep-ignore: silent-default-return -- a file without [rust] configures no runs; a malformed table throws below
  if (doc.rust === undefined) return [];
  const parsed = RustTable.safeParse(doc.rust);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OverrideConfigError(
      `${path}: [[${CARGO_CONFIG_KEY}]] ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"} (keys: root, target, packages, exclude_packages)`,
    );
  }
  return parsed.data.cargo.map((e, i) => {
    const label = `[[${CARGO_CONFIG_KEY}]] #${i + 1}`;
    if (e.packages.length > 0 && e.exclude_packages.length > 0) {
      throw new OverrideConfigError(
        `${path}: ${label} sets both packages and exclude_packages; use one (packages = -p, exclude_packages = --workspace --exclude)`,
      );
    }
    return {
      root: normRoot(e.root),
      target:
        e.target === "host"
          ? { kind: "host" as const }
          : { kind: "triple" as const, triple: e.target },
      selection:
        e.packages.length > 0
          ? { kind: "packages" as const, names: e.packages }
          : { kind: "workspace" as const, exclude: e.exclude_packages },
      label,
    };
  });
}
