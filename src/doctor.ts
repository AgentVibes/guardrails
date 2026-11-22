import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import {
  hasLanguage,
  type LanguageSet,
  languagesOrDetected,
  resolveLanguages,
} from "./lang/languages.js";
import {
  RUST_TOOLS,
  type RustToolName,
  type RustToolReport,
  rustToolReport,
} from "./lang/rust/rustTools.js";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { collectOverrides, type OverrideReport } from "./overrides.js";
import { packageRoot, rulesDir, structureRulesDir } from "./packagePaths.js";
import { driftMessage, presetDrift } from "./presetDrift.js";
import { declaredRuleDirs } from "./repoRules.js";
import { pinnedVersion, tryResolveTool } from "./toolResolve.js";
import { detectWiring, type WiringReport } from "./wiring.js";

interface ToolReport {
  found: boolean;
  version?: string;
  via?: "path" | "mise";
  pin?: string;
  hint?: string;
}

function reportTool(name: string): ToolReport {
  const pin = pinnedVersion(name);
  const resolved = tryResolveTool(name);
  if (resolved === undefined) {
    return {
      found: false,
      ...(pin !== undefined ? { pin } : {}),
      hint: `mise use -g ${name}@${pin ?? "latest"}`,
    };
  }
  return {
    found: true,
    version: resolved.version,
    via: resolved.via,
    ...(pin !== undefined ? { pin } : {}),
  };
}

/**
 * Stable digest of every bundled rule file (canon + structure marker), so two
 * hosts can compare "which ruleset did your gate actually run" by one string.
 */
export function rulesetSha(): string {
  const hash = createHash("sha256");
  for (const dir of [rulesDir, structureRulesDir]) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".yml"))
      .sort();
    for (const f of files) {
      hash.update(f);
      hash.update("\0");
      hash.update(readFileSync(join(dir, f)));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function discoverConfigs(cwd: string): Record<string, string> {
  const found: Record<string, string> = {};
  const sg = join(cwd, "sgconfig.yml");
  if (existsSync(sg)) {
    // Name the ruleDirs, not just the file. `verify` scans with this config IN
    // ADDITION to the canon, so what it lists is what the repo
    // adds on top — and a repo that thinks it has local rules can see here
    // whether the config actually declares the directory holding them.
    const dirs = declaredRuleDirs(sg);
    found["sgconfig.yml"] =
      dirs.length > 0 ? `present, ruleDirs: ${dirs.join(", ")}` : "present, no ruleDirs declared";
  } else {
    found["sgconfig.yml"] = "absent";
  }

  const biomePath = join(cwd, "biome.json");
  if (existsSync(biomePath)) {
    const extendsPreset = readFileSync(biomePath, "utf8").includes("@agentvibes/guardrails/biome");
    found["biome.json"] = extendsPreset
      ? "present, extends @agentvibes/guardrails/biome"
      : "present";
  } else {
    found["biome.json"] = "absent";
  }

  const tomlPath = join(cwd, ".agentvibes", "project.toml");
  if (existsSync(tomlPath)) {
    const hasStack = /^\[stack\]/m.test(readFileSync(tomlPath, "utf8"));
    found[".agentvibes/project.toml"] = hasStack ? "present, has [stack]" : "present, no [stack]";
  } else {
    found[".agentvibes/project.toml"] = "absent";
  }
  return found;
}

type LanguagesRead = ({ status: "read" } & LanguageSet) | { status: "unreadable"; error: string };

function readLanguages(root: string): LanguagesRead {
  try {
    return { status: "read", ...resolveLanguages(root) };
  } catch (err) {
    if (err instanceof OverrideConfigError) return { status: "unreadable", error: err.message };
    throw err;
  }
}

type OverridesRead =
  | ({ status: "read" } & OverrideReport)
  | { status: "unreadable"; error: string };

/** The overrides inventory for doctor: reported, never gating (drift already gates a bad declaration file). */
function readOverrides(root: string): OverridesRead {
  try {
    return { status: "read", ...collectOverrides(root) };
  } catch (err) {
    if (err instanceof OverrideConfigError) return { status: "unreadable", error: err.message };
    throw err;
  }
}

export function runDoctor(json: boolean, root: string = process.cwd()): number {
  const version = (
    JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }
  ).version;
  const languages = readLanguages(root);
  // A malformed [languages] table is reported and fails doctor; the rest of
  // the report runs on what detection finds.
  const enabled = languagesOrDetected(root);
  const typescript = hasLanguage(enabled, "typescript");
  const rust = hasLanguage(enabled, "rust");
  const overrides = readOverrides(root);
  // Wiring (wiring.ts) is a report: it never changes doctor's exit code.
  const wiring = detectWiring(
    root,
    match(overrides)
      .with({ status: "read" }, (r) => r)
      .with({ status: "unreadable" }, () => undefined)
      .exhaustive(),
  );
  const result = {
    command: "doctor",
    package: { name: "@agentvibes/guardrails", version, root: packageRoot },
    node: process.version,
    languages,
    tools: {
      "ast-grep": reportTool("ast-grep"),
      biome: reportTool("biome"),
      mise: tryResolveTool("mise") !== undefined,
      ...(rust
        ? {
            rust: Object.fromEntries(RUST_TOOLS.map((t) => [t, rustToolReport(root, t)])) as Record<
              RustToolName,
              RustToolReport
            >,
          }
        : {}),
    },
    rulesetSha: rulesetSha(),
    configDiscovery: discoverConfigs(root),
    // Preset drift: reported and gated in every repo, the same
    // rule `verify` applies.
    presetDrift: { findings: typescript ? presetDrift(root) : [] },
    overrides,
    wiring,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`@agentvibes/guardrails ${version} (${packageRoot})`);
    console.log(`node       ${result.node}`);
    for (const name of ["ast-grep", "biome"] as const) {
      const t = result.tools[name];
      console.log(
        t.found
          ? `${name.padEnd(10)} ${t.version} (via ${t.via}${t.pin !== undefined ? `, pin ${t.pin}` : ""})`
          : `${name.padEnd(10)} MISSING — install: ${t.hint}`,
      );
    }
    console.log(`mise       ${result.tools.mise ? "present" : "absent"}`);
    for (const [name, t] of Object.entries(result.tools.rust ?? {})) {
      console.log(
        t.found ? `${name.padEnd(10)} ${t.version}` : `${name.padEnd(10)} MISSING — ${t.hint}`,
      );
    }
    printLanguages(languages);
    console.log(`ruleset    sha256:${result.rulesetSha.slice(0, 16)}…`);
    console.log(`config discovery in ${root}:`);
    for (const [k, v] of Object.entries(result.configDiscovery)) {
      console.log(`  ${k.padEnd(28)} ${v}`);
    }
    if (result.presetDrift.findings.length === 0) {
      console.log("biome preset  no drift");
    } else {
      console.log("biome preset  DRIFT");
      for (const f of result.presetDrift.findings) console.log(`  ${f.detail}`);
    }
    printOverrides(result.overrides);
    printWiring(result.wiring);
  }
  // The tools a language needs are required only when that language is enabled.
  const tsFound = !typescript || (result.tools["ast-grep"].found && result.tools.biome.found);
  const rustFound = Object.values(result.tools.rust ?? {}).every((t) => t.found);
  const allFound = tsFound && rustFound && languages.status === "read";
  const drifted = result.presetDrift.findings.length > 0;
  if (drifted && !json)
    console.error(`guardrails doctor: ${driftMessage(result.presetDrift.findings)}`);
  return allFound && !drifted ? 0 : 1;
}

function printLanguages(read: LanguagesRead): void {
  match(read)
    .with({ status: "unreadable" }, (r) => console.log(`languages     UNREADABLE — ${r.error}`))
    .with({ status: "read" }, (r) => {
      console.log(`languages     ${r.languages.join(", ")} (${r.source})`);
      for (const e of r.evidence) console.log(`  ${e}`);
    })
    .exhaustive();
}

function printOverrides(read: OverridesRead): void {
  match(read)
    .with({ status: "unreadable" }, (r) => console.log(`overrides     UNREADABLE — ${r.error}`))
    .with({ status: "read" }, (r) => {
      const missing = r.overrides.filter((o) => o.reason.status === "missing");
      console.log(`overrides     ${r.overrides.length}, ${missing.length} without a reason`);
      const SHOWN = 20;
      for (const f of r.findings.slice(0, SHOWN)) console.log(`  ${f.rule}: ${f.message}`);
      if (r.findings.length > SHOWN) {
        console.log(
          `  … ${r.findings.length - SHOWN} more: guardrails doctor --json lists every one`,
        );
      }
    })
    .exhaustive();
}

function printWiring(w: WiringReport): void {
  console.log(`wiring        ${w.state.toUpperCase()}`);
  for (const c of w.checks)
    console.log(`  ${c.status === "pass" ? "ok  " : "MISS"} ${c.id.padEnd(20)} ${c.detail}`);
  match(w.overrides)
    .with({ status: "counted" }, (o) => {
      if (o.total > 0) console.log(`  (${o.total} override(s) of the canon keep it from ON)`);
    })
    .with({ status: "unreadable" }, (o) => console.log(`  overrides unreadable: ${o.error}`))
    .exhaustive();
}
