import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import { writeClaudeHooks } from "../../claudeHooks.js";
import { packageRoot } from "../../packagePaths.js";
import { type CargoRoot, cargoRoots, type Manifest } from "./cargoManifest.js";
import { CANON_PATH } from "./lintTable.js";
import { governingLints } from "./rustWiring.js";

// `guardrails init` for Rust. Each step only ADDS: a file that exists, or a
// table the manifest already has, is left as it is and reported as skipped;
// doctor then says what the existing one lacks.
//
//   - the canon lint table: `[workspace.lints.*]` in a workspace root, or
//     `[lints.*]` in a single crate, when the manifest has none;
//   - `[lints] workspace = true` in every workspace crate without [lints];
//   - rust-toolchain.toml (the installed stable version, clippy + rustfmt);
//   - clippy.toml (unwrap/expect/panic allowed in tests);
//   - the PostToolUse and Stop hooks in .claude/settings.json (claudeHooks.ts),
//     and an old unguarded hook command rewritten to the guarded form.

export interface RustInitAction {
  file: string;
  action: "created" | "appended" | "upgraded" | "skipped-exists" | "skipped-unreadable";
  detail?: string;
}

function manifestRel(m: Manifest): string {
  return m.rel === "" ? "Cargo.toml" : `${m.rel}/Cargo.toml`;
}

function rootRel(r: CargoRoot, file: string): string {
  return r.rel === "" ? file : `${r.rel}/${file}`;
}

function canonText(prefix: "workspace.lints" | "lints"): string {
  const text = readFileSync(CANON_PATH, "utf8");
  const body = text.slice(text.search(/^\[/m));
  const tables = prefix === "lints" ? body.replaceAll("[workspace.lints.", "[lints.") : body;
  return `\n# The @agentvibes/guardrails Clippy canon, written by guardrails init.\n# CI runs clippy with -D warnings. README "Rust" in @agentvibes/guardrails gives the reasons.\n${tables}`;
}

function appendTo(path: string, text: string): void {
  const current = readFileSync(path, "utf8");
  appendFileSync(path, current.endsWith("\n") ? text : `\n${text}`);
}

function lintTable(r: CargoRoot): RustInitAction {
  return match(governingLints(r))
    .with({ status: "set" }, (l) => ({
      file: manifestRel(r.manifest),
      action: "skipped-exists" as const,
      detail: `[${l.prefix}] is already set; guardrails doctor compares it with the canon`,
    }))
    .with({ status: "absent" }, (l) => {
      appendTo(r.manifest.path, canonText(l.prefix));
      return {
        file: manifestRel(r.manifest),
        action: "appended" as const,
        detail: `the canon as [${l.prefix}.*]`,
      };
    })
    .exhaustive();
}

function inherit(r: CargoRoot): RustInitAction[] {
  return match(r.manifest.workspace)
    .with({ kind: "none" }, () => [])
    .with({ kind: "workspace" }, () =>
      [...(r.manifest.packageName === undefined ? [] : [r.manifest]), ...r.members].map(inheritOne),
    )
    .exhaustive();
}

function inheritOne(m: Manifest): RustInitAction {
  return match(m.lints)
    .with({ kind: "absent" }, () => {
      appendTo(m.path, "\n[lints]\nworkspace = true\n");
      return {
        file: manifestRel(m),
        action: "appended" as const,
        detail: "[lints] workspace = true",
      };
    })
    .with({ kind: "inherits" }, () => ({
      file: manifestRel(m),
      action: "skipped-exists" as const,
      detail: "[lints] workspace = true",
    }))
    .with({ kind: "own" }, () => ({
      file: manifestRel(m),
      action: "skipped-exists" as const,
      detail: "has its own [lints] table",
    }))
    .exhaustive();
}

/** `1.94.1` from `rustc --version` in `dir`, or `stable` when rustc is not there. */
function installedChannel(dir: string): string {
  const res = spawnSync("rustc", ["--version"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  const m = /^rustc (\d+\.\d+\.\d+)/.exec(res.stdout ?? "");
  return m?.[1] ?? "stable";
}

function toolchain(root: string, r: CargoRoot): RustInitAction {
  for (const d of [...new Set([r.manifest.dir, root])]) {
    for (const f of ["rust-toolchain.toml", "rust-toolchain"]) {
      if (existsSync(join(d, f)))
        return { file: d === root ? f : rootRel(r, f), action: "skipped-exists" };
    }
  }
  const channel = installedChannel(r.manifest.dir);
  writeFileSync(
    join(r.manifest.dir, "rust-toolchain.toml"),
    `[toolchain]\nchannel = "${channel}"\ncomponents = ["clippy", "rustfmt"]\n`,
  );
  return {
    file: rootRel(r, "rust-toolchain.toml"),
    action: "created",
    detail: `channel ${channel}`,
  };
}

function clippyConfig(r: CargoRoot): RustInitAction {
  for (const f of ["clippy.toml", ".clippy.toml"]) {
    if (existsSync(join(r.manifest.dir, f)))
      return { file: rootRel(r, f), action: "skipped-exists" };
  }
  writeFileSync(
    join(r.manifest.dir, "clippy.toml"),
    readFileSync(join(packageRoot, "configs", "clippy.toml"), "utf8"),
  );
  return { file: rootRel(r, "clippy.toml"), action: "created" };
}

function claudeHooks(root: string): RustInitAction {
  return writeClaudeHooks(root, "add");
}

export function rustInit(root: string): RustInitAction[] {
  const roots = cargoRoots(root);
  return [
    ...roots.flatMap((r) => [lintTable(r), ...inherit(r), toolchain(root, r), clippyConfig(r)]),
    claudeHooks(root),
  ];
}
