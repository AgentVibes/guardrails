import { join } from "node:path";
import type { DeployContext } from "./pluginApi.js";
import { loadPlugin, PluginResolutionError, resolvePluginName } from "./pluginResolve.js";
import { readTomlTable } from "./tomlTable.js";

const DOC =
  "See README 'Deploy plugins': install a guardrails-plugin-* package (or set `plugin = \"<npm name>\"` under [deploy] in .agentvibes/project.toml). The public CLI carries no deploy topology of its own.";

export async function runDeploy(args: string[], json: boolean): Promise<number> {
  const cwd = process.cwd();
  const deployConfig = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "deploy");

  let pluginName: string | undefined;
  try {
    pluginName = resolvePluginName(cwd);
  } catch (err) {
    console.error(`guardrails deploy: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (pluginName === undefined) {
    console.error(`guardrails deploy: no deploy plugin found in this project. ${DOC}`);
    return 2;
  }

  let plugin: Awaited<ReturnType<typeof loadPlugin>>;
  try {
    plugin = await loadPlugin(cwd, pluginName);
  } catch (err) {
    if (err instanceof PluginResolutionError) {
      console.error(`guardrails deploy: ${err.message} ${DOC}`);
      return 2;
    }
    throw err;
  }

  const context: DeployContext = { cwd, deployConfig, json };
  return await plugin.deploy(args, context);
}
