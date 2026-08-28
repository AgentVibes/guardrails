import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, rulesDir, structureRulesDir } from "./packagePaths.js";
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
  found["sgconfig.yml"] = existsSync(sg) ? "present" : "absent";

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
  }
  const allFound = result.tools["ast-grep"].found && result.tools.biome.found;
  return allFound ? 0 : 1;
}
