import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listWorkspacePackages } from "./workspaces.js";

// `guardrails init` — repo stubs, config-over-inference (spec §5 layer B′.2):
// the stack is DETECTED once from package.json, printed, and MATERIALIZED into
// .agentvibes/project.toml [stack]. Nothing ever acts on a silent guess — the
// inference is a one-time bootstrap with an explicit trace in the diff, and
// from then on the TOML is a hand-editable constant.

interface Stack {
  platform: string;
  state: string;
  storeRuntime: string;
  styling: string;
  componentModel: string;
}

interface Action {
  file: string;
  action: "created" | "appended" | "skipped-exists";
}

/** Per-package detection signals; a package with none contributes nothing. */
interface AppSignals {
  name: string;
  platform?: string;
  state?: "mobx";
  styling?: string;
}

export interface DetectedStack {
  stack: Stack;
  /** workspace packages that carried at least one signal */
  apps: AppSignals[];
  /** fields where signal-bearing apps disagree — per-app blocks get emitted */
  conflicts: (keyof Stack)[];
  hadPackageJson: boolean;
}

function signalsOf(name: string, deps: Record<string, string>): AppSignals | undefined {
  const has = (dep: string): boolean => dep in deps;
  const platform = has("expo")
    ? "expo"
    : has("next")
      ? "next-client"
      : has("vite")
        ? "vite-spa"
        : undefined;
  const state = has("mobx") ? ("mobx" as const) : undefined;
  const stylingDep = has("nativewind") ? "nativewind" : has("tailwindcss") ? "tailwind" : undefined;
  if (platform === undefined && state === undefined && stylingDep === undefined) return undefined;
  // An app (something with a platform) that installs no styling system is
  // theme-inline by house convention; a library without a platform makes no
  // styling claim at all.
  const styling = stylingDep ?? (platform !== undefined ? "theme-inline" : undefined);
  return {
    name,
    ...(platform !== undefined ? { platform } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(styling !== undefined ? { styling } : {}),
  };
}

// Monorepo-aware: the root package.json of a workspace repo is dependency-
// empty, so signals are gathered from every workspace package too (the
// observatory adoption hit exactly this — root-only detection said state=none
// for a mobx repo). When signal-bearing apps DISAGREE on a field, the
// aggregate takes the first app's value and a per-app block is materialized
// for each, so the disagreement is visible in the TOML instead of averaged
// away. Manual editing of the materialized file remains the designed fallback.
function detectStack(cwd: string): DetectedStack {
  const pkgPath = join(cwd, "package.json");
  let rootDeps: Record<string, string> = {};
  const hadPackageJson = existsSync(pkgPath);
  if (hadPackageJson) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    rootDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  }

  const apps: AppSignals[] = [];
  const rootSignals = signalsOf("(root)", rootDeps);
  if (rootSignals !== undefined) apps.push(rootSignals);
  for (const ws of listWorkspacePackages(cwd)) {
    const s = signalsOf(ws.name, ws.deps);
    if (s !== undefined) apps.push(s);
  }

  const distinct = (field: "platform" | "state" | "styling"): string[] => [
    ...new Set(apps.map((a) => a[field]).filter((v): v is string => v !== undefined)),
  ];
  const platforms = distinct("platform");
  const stylings = distinct("styling");
  const state = apps.some((a) => a.state === "mobx") ? "mobx" : "none";

  const conflicts: (keyof Stack)[] = [];
  if (platforms.length > 1) conflicts.push("platform");
  if (stylings.length > 1) conflicts.push("styling");

  const stack: Stack = {
    platform: platforms[0] ?? "unknown",
    state,
    storeRuntime: state === "mobx" ? "client-singleton" : "none",
    styling: stylings[0] ?? "theme-inline",
    componentModel: "conventional",
  };
  return { stack, apps, conflicts, hadPackageJson };
}

function stackToml(detected: DetectedStack): string {
  const { stack, apps, conflicts } = detected;
  const provenance =
    apps.length > 0 ? `# detected from: ${apps.map((a) => a.name).join(", ")}` : undefined;
  const lines = [
    "[stack]",
    ...(provenance !== undefined ? [provenance] : []),
    ...(conflicts.length > 0
      ? [`# apps disagree on: ${conflicts.join(", ")} — per-app values below; edit as needed`]
      : []),
    `platform = "${stack.platform}"                # vite-spa | expo | next-client | next-ssr`,
    `state = "${stack.state}"                      # mobx | none`,
    `storeRuntime = "${stack.storeRuntime}"        # client-singleton | request-scoped | none`,
    `styling = "${stack.styling}"                  # theme-inline | tailwind | nativewind`,
    `componentModel = "${stack.componentModel}"    # two-tier | conventional`,
  ];
  if (conflicts.length > 0) {
    for (const app of apps) {
      lines.push("", `[stack.app."${app.name}"]`);
      if (app.platform !== undefined) lines.push(`platform = "${app.platform}"`);
      if (app.state !== undefined) lines.push(`state = "${app.state}"`);
      if (app.styling !== undefined) lines.push(`styling = "${app.styling}"`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const SGCONFIG_STUB = `# ast-grep config — rules come from the @agentvibes/guardrails package.
# Add repo-local extra rules by creating .ast-grep/rules/ and uncommenting the
# second ruleDir. Run: guardrails verify [paths]
ruleDirs:
  - node_modules/@agentvibes/guardrails/rules
  # - .ast-grep/rules
`;

const BIOME_STUB = `{
  "$schema": "https://biomejs.dev/schemas/2.5.10/schema.json",
  "extends": ["@agentvibes/guardrails/biome"]
}
`;

export function runInit(json: boolean): number {
  const cwd = process.cwd();
  const actions: Action[] = [];
  const detected = detectStack(cwd);
  const { stack, apps, conflicts, hadPackageJson } = detected;

  const sgPath = join(cwd, "sgconfig.yml");
  if (existsSync(sgPath)) {
    actions.push({ file: "sgconfig.yml", action: "skipped-exists" });
  } else {
    writeFileSync(sgPath, SGCONFIG_STUB);
    actions.push({ file: "sgconfig.yml", action: "created" });
  }

  const biomePath = join(cwd, "biome.json");
  if (existsSync(biomePath)) {
    actions.push({ file: "biome.json", action: "skipped-exists" });
  } else {
    writeFileSync(biomePath, BIOME_STUB);
    actions.push({ file: "biome.json", action: "created" });
  }

  const tomlDir = join(cwd, ".agentvibes");
  const tomlPath = join(tomlDir, "project.toml");
  if (!existsSync(tomlPath)) {
    mkdirSync(tomlDir, { recursive: true });
    writeFileSync(tomlPath, `${stackToml(detected)}`);
    actions.push({ file: ".agentvibes/project.toml", action: "created" });
  } else if (/^\[stack\]/m.test(readFileSync(tomlPath, "utf8"))) {
    actions.push({ file: ".agentvibes/project.toml", action: "skipped-exists" });
  } else {
    appendFileSync(tomlPath, `\n${stackToml(detected)}`);
    actions.push({ file: ".agentvibes/project.toml", action: "appended" });
  }

  if (json) {
    console.log(
      JSON.stringify(
        { command: "init", detected: stack, apps, conflicts, hadPackageJson, actions },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(
    `guardrails init — detected stack${hadPackageJson ? "" : " (no package.json found — all defaults)"}:`,
  );
  console.log(
    `  platform=${stack.platform} state=${stack.state} storeRuntime=${stack.storeRuntime} styling=${stack.styling} componentModel=${stack.componentModel}`,
  );
  if (apps.length > 0) {
    console.log(`  signal packages: ${apps.map((a) => a.name).join(", ")}`);
  }
  if (conflicts.length > 0) {
    console.log(
      `  apps DISAGREE on ${conflicts.join(", ")} — per-app [stack.app] blocks materialized; edit them by hand`,
    );
  }
  for (const a of actions) console.log(`  ${a.action.padEnd(14)} ${a.file}`);
  const skippedStack = actions.some(
    (a) => a.file === ".agentvibes/project.toml" && a.action === "skipped-exists",
  );
  if (skippedStack) {
    console.log(
      "  [stack] already declared — the existing config wins over detection; edit it by hand.",
    );
  } else {
    console.log(
      "  Detected values are now MATERIALIZED in .agentvibes/project.toml — edit them there;",
    );
    console.log("  nothing re-infers them silently.");
  }
  return 0;
}
