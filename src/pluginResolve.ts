import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type GuardrailsDeployPlugin, isDeployPlugin } from "./pluginApi.js";
import { readTomlTable } from "./tomlTable.js";

// Shared plugin resolution for `deploy` and `leaks`: [deploy] plugin= in the
// manifest wins, else a single guardrails-plugin-* dependency.

export class PluginResolutionError extends Error {}

function pluginsFromPackageJson(cwd: string): string[] {
  const pkgPath = join(cwd, "package.json");
  // ast-grep-ignore: silent-default-return -- a directory without package.json legitimately has no installable plugins; callers report their own "no plugin" outcome
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
    /(^|\/)guardrails-plugin-/.test(name),
  );
}

export function resolvePluginName(cwd: string): string | undefined {
  const deployConfig = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "deploy");
  const configured = deployConfig.plugin;
  if (configured !== undefined && configured !== "") return configured;
  const found = pluginsFromPackageJson(cwd);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new PluginResolutionError(
      `several deploy plugins installed (${found.join(", ")}) — pin one with \`plugin = "<name>"\` under [deploy] in .agentvibes/project.toml`,
    );
  }
  return undefined;
}

/** Import a resolved plugin module; throws PluginResolutionError with a usable message. */
export async function loadPlugin(cwd: string, pluginName: string): Promise<GuardrailsDeployPlugin> {
  let resolved: string;
  try {
    resolved = createRequire(join(cwd, "package.json")).resolve(pluginName);
  } catch {
    throw new PluginResolutionError(
      `plugin '${pluginName}' is configured but not installed (module resolution failed from ${cwd}). Install it, then retry.`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  const candidate = mod.default ?? mod.plugin;
  if (!isDeployPlugin(candidate)) {
    throw new PluginResolutionError(
      `'${pluginName}' does not export a guardrails plugin (need default or named 'plugin' export with { name, deploy }).`,
    );
  }
  return candidate;
}
