import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

function detectStack(cwd: string): { stack: Stack; hadPackageJson: boolean } {
  const pkgPath = join(cwd, "package.json");
  let deps: Record<string, string> = {};
  let hadPackageJson = false;
  if (existsSync(pkgPath)) {
    hadPackageJson = true;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  }
  const has = (name: string): boolean => name in deps;

  const platform = has("expo")
    ? "expo"
    : has("next")
      ? "next-client"
      : has("vite")
        ? "vite-spa"
        : "unknown";
  const state = has("mobx") ? "mobx" : "none";
  const styling = has("nativewind")
    ? "nativewind"
    : has("tailwindcss")
      ? "tailwind"
      : "theme-inline";
  return {
    stack: {
      platform,
      state,
      storeRuntime: state === "mobx" ? "client-singleton" : "none",
      styling,
      componentModel: "conventional",
    },
    hadPackageJson,
  };
}

function stackToml(stack: Stack): string {
  return [
    "[stack]",
    `platform = "${stack.platform}"                # vite-spa | expo | next-client | next-ssr`,
    `state = "${stack.state}"                      # mobx | none`,
    `storeRuntime = "${stack.storeRuntime}"        # client-singleton | request-scoped | none`,
    `styling = "${stack.styling}"                  # theme-inline | tailwind | nativewind`,
    `componentModel = "${stack.componentModel}"    # two-tier | conventional`,
    "",
  ].join("\n");
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
  const { stack, hadPackageJson } = detectStack(cwd);

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
    writeFileSync(tomlPath, `${stackToml(stack)}`);
    actions.push({ file: ".agentvibes/project.toml", action: "created" });
  } else if (/^\[stack\]/m.test(readFileSync(tomlPath, "utf8"))) {
    actions.push({ file: ".agentvibes/project.toml", action: "skipped-exists" });
  } else {
    appendFileSync(tomlPath, `\n${stackToml(stack)}`);
    actions.push({ file: ".agentvibes/project.toml", action: "appended" });
  }

  if (json) {
    console.log(
      JSON.stringify({ command: "init", detected: stack, hadPackageJson, actions }, null, 2),
    );
    return 0;
  }
  console.log(
    `guardrails init — detected stack${hadPackageJson ? "" : " (no package.json found — all defaults)"}:`,
  );
  console.log(
    `  platform=${stack.platform} state=${stack.state} storeRuntime=${stack.storeRuntime} styling=${stack.styling} componentModel=${stack.componentModel}`,
  );
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
