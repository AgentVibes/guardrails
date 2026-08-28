import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type DeployContext, isDeployPlugin } from "./pluginApi.js";

const DOC =
  "See README 'Deploy plugins': install a guardrails-plugin-* package (or set `plugin = \"<npm name>\"` under [deploy] in .agentvibes/project.toml). The public CLI carries no deploy topology of its own.";

/** Raw key = "value" pairs of one TOML table; enough for [deploy] lookup. */
function readTomlTable(path: string, table: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  let inTable = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable = line === `[${table}]`;
      continue;
    }
    if (!inTable || line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
    const key = m?.[1];
    const value = m?.[2];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

function pluginsFromPackageJson(cwd: string): string[] {
  const pkgPath = join(cwd, "package.json");
  // ast-grep-ignore: silent-default-return -- a directory without package.json legitimately has no installable plugins; the caller reports "no deploy plugin found" with the doc pointer
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
    /(^|\/)guardrails-plugin-/.test(name),
  );
}

function resolvePluginName(cwd: string, deployConfig: Record<string, string>): string | undefined {
  const configured = deployConfig.plugin;
  if (configured !== undefined && configured !== "") return configured;
  const found = pluginsFromPackageJson(cwd);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Error(
      `several deploy plugins installed (${found.join(", ")}) — pin one with \`plugin = "<name>"\` under [deploy] in .agentvibes/project.toml`,
    );
  }
  return undefined;
}

export async function runDeploy(args: string[], json: boolean): Promise<number> {
  const cwd = process.cwd();
  const deployConfig = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "deploy");

  let pluginName: string | undefined;
  try {
    pluginName = resolvePluginName(cwd, deployConfig);
  } catch (err) {
    console.error(`guardrails deploy: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (pluginName === undefined) {
    console.error(`guardrails deploy: no deploy plugin found in this project. ${DOC}`);
    return 2;
  }

  let resolved: string;
  try {
    resolved = createRequire(join(cwd, "package.json")).resolve(pluginName);
  } catch {
    console.error(
      `guardrails deploy: plugin '${pluginName}' is configured but not installed (module resolution failed from ${cwd}). Install it, then retry. ${DOC}`,
    );
    return 2;
  }

  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  const candidate = mod.default ?? mod.plugin;
  if (!isDeployPlugin(candidate)) {
    console.error(
      `guardrails deploy: '${pluginName}' does not export a deploy plugin (need default or named 'plugin' export with { name, deploy }).`,
    );
    return 2;
  }

  const context: DeployContext = { cwd, deployConfig, json };
  return await candidate.deploy(args, context);
}
