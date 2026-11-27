import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { hasLanguage, languagesOrDetected } from "../lang/languages.js";
import { packageRoot } from "../packagePaths.js";
import { hasAnyFile, readRootPackage } from "./resolveBinary.js";
import type { TaskProvider } from "./types.js";

function checkArgs(subcommand: readonly string[], args: readonly string[]): string[] {
  if (args.length === 0) return [...subcommand, "."];
  if (args.some((a) => !a.startsWith("-"))) return [...subcommand, ...args];
  return [...subcommand, ".", ...args];
}

function runGuardrailsLintFollowUp(root: string): number {
  const cli = join(packageRoot, "dist", "cli.js");
  const env = { ...process.env, GUARDRAILS_RECORD: "" };
  for (const sub of ["verify-diff", "doctor"] as const) {
    const res = spawnSync(process.execPath, [cli, sub], { cwd: root, stdio: "inherit", env });
    if (res.error) {
      console.error(`guardrails lint: failed to run guardrails ${sub}: ${res.error.message}`);
      return 2;
    }
    if ((res.status ?? 1) !== 0) return res.status ?? 1;
  }
  return 0;
}

export const biomeLintProvider: TaskProvider = {
  id: "biome",
  verb: "lint",
  binary: "biome",
  installHint: "pnpm add -D @biomejs/biome (or mise use -g biome@latest)",
  detect: (root) => {
    const cfg = hasAnyFile(root, ["biome.json", "biome.jsonc"]);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    if (hasLanguage(languagesOrDetected(root), "typescript")) {
      return { applicable: true, reason: "TypeScript project (default)" };
    }
    return { applicable: false, reason: "no TypeScript project or biome config" };
  },
  priority: (root) => (hasAnyFile(root, ["biome.json", "biome.jsonc"]) !== undefined ? 20 : 10),
  command: (_root, args) => checkArgs(["check"], args),
  after: (root) => runGuardrailsLintFollowUp(root),
};

const OXLINT_FILES = [
  ".oxlintrc.json",
  "oxlint.config.ts",
  "oxlint.config.mts",
  "oxlint.config.js",
  "oxlint.config.mjs",
] as const;

export const oxlintProvider: TaskProvider = {
  id: "oxlint",
  verb: "lint",
  binary: "oxlint",
  installHint: "pnpm add -D oxlint",
  detect: (root) => {
    const cfg = hasAnyFile(root, OXLINT_FILES);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    const pkg = readRootPackage(root);
    if (pkg?.allDeps.oxlint !== undefined) {
      return { applicable: true, reason: "oxlint in package.json" };
    }
    return { applicable: false, reason: "no oxlint config or dependency" };
  },
  priority: (root) => (hasAnyFile(root, ["biome.json", "biome.jsonc"]) !== undefined ? 5 : 15),
  command: (_root, args) => checkArgs([], args),
  after: (root) => runGuardrailsLintFollowUp(root),
};

export const LINT_PROVIDERS: readonly TaskProvider[] = [biomeLintProvider, oxlintProvider];
