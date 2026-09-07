import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, rulesDir, structureRulesDir } from "./packagePaths.js";
import { driftMessage, presetDrift, presetEnforced } from "./presetDrift.js";
import { declaredRuleDirs } from "./repoRules.js";
import { pinnedVersion, tryResolveTool } from "./toolResolve.js";

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
    // ADDITION to the canon (is-f58cd6b4), so what it lists is what the repo
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

export function runDoctor(json: boolean): number {
  const version = (
    JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }
  ).version;
  const result = {
    command: "doctor",
    package: { name: "@agentvibes/guardrails", version, root: packageRoot },
    node: process.version,
    tools: {
      "ast-grep": reportTool("ast-grep"),
      biome: reportTool("biome"),
      mise: tryResolveTool("mise") !== undefined,
    },
    rulesetSha: rulesetSha(),
    configDiscovery: discoverConfigs(process.cwd()),
    // Preset drift (is-9c7a78d7). `doctor` REPORTS it wherever it exists —
    // seeing it is the point of this command — and exits non-zero only where
    // the repo has opted in with `[biome] preset = "enforced"`, the same switch
    // `verify` reads. Reporting everywhere and gating on the flag is what lets
    // the epic migrate 37 configs without reddening 5 gates on day one.
    presetDrift: {
      enforced: presetEnforced(process.cwd()),
      findings: presetDrift(process.cwd()),
    },
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
    console.log(`ruleset    sha256:${result.rulesetSha.slice(0, 16)}…`);
    console.log(`config discovery in ${process.cwd()}:`);
    for (const [k, v] of Object.entries(result.configDiscovery)) {
      console.log(`  ${k.padEnd(28)} ${v}`);
    }
    if (result.presetDrift.findings.length === 0) {
      console.log("biome preset  no drift");
    } else {
      console.log(
        `biome preset  ${result.presetDrift.enforced ? "DRIFT (enforced here)" : "drift (not enforced here yet)"}`,
      );
      for (const f of result.presetDrift.findings) console.log(`  ${f.detail}`);
      if (!result.presetDrift.enforced) {
        console.log(
          '  Add [biome] preset = "enforced" to .agentvibes/project.toml once this repo is migrated (epic is-a70a5963).',
        );
      }
    }
  }
  const allFound = result.tools["ast-grep"].found && result.tools.biome.found;
  const drifted = result.presetDrift.enforced && result.presetDrift.findings.length > 0;
  if (drifted && !json)
    console.error(`guardrails doctor: ${driftMessage(result.presetDrift.findings)}`);
  return allFound && !drifted ? 0 : 1;
}
