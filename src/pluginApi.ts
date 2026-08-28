// The deploy extension point (spec layer A″). The public CLI knows the
// MECHANISM only: find a plugin, hand it the args and the project's [deploy]
// config. Every FACT of a concrete topology (hosts, orgs, registries, SSO)
// lives in a private plugin package — the public code physically contains
// none of it, and `guardrails leaks` keeps it that way.

export interface DeployContext {
  cwd: string;
  /** raw key/value pairs of the [deploy] table in .agentvibes/project.toml */
  deployConfig: Record<string, string>;
  json: boolean;
}

export interface GuardrailsDeployPlugin {
  name: string;
  /** returns the process exit code */
  deploy(args: string[], context: DeployContext): Promise<number> | number;
}

export function isDeployPlugin(value: unknown): value is GuardrailsDeployPlugin {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.deploy === "function";
}
