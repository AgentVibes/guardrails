import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasLanguage, languagesOrDetected } from "../lang/languages.js";
import {
  findLocalBin,
  installedPackageVersion,
  parseMajorVersion,
  readRootPackage,
} from "./resolveBinary.js";
import type { TaskProvider } from "./types.js";

function typescriptVersionInfo(root: string): { version?: string; major?: number } {
  const installed = installedPackageVersion(root, "typescript");
  if (installed !== undefined) {
    return { version: installed, major: parseMajorVersion(installed) };
  }
  const pkg = readRootPackage(root);
  const declared = pkg?.allDeps.typescript;
  if (declared !== undefined) {
    return { version: declared, major: parseMajorVersion(declared) };
  }
  return {};
}

function hasTsgoSignal(root: string): boolean {
  if (installedPackageVersion(root, "@typescript/native-preview") !== undefined) return true;
  if (readRootPackage(root)?.allDeps["@typescript/native-preview"] !== undefined) return true;
  return findLocalBin(root, "tsgo") !== undefined;
}

function isTypescriptProject(root: string): boolean {
  return (
    existsSync(join(root, "tsconfig.json")) || hasLanguage(languagesOrDetected(root), "typescript")
  );
}

function tsTypecheckArgs(root: string, args: readonly string[]): string[] {
  const out: string[] = args.includes("--noEmit") ? [] : ["--noEmit"];
  const hasProjectFlag = args.some(
    (a) => a === "-p" || a === "--project" || a.startsWith("-p=") || a.startsWith("--project="),
  );
  if (hasProjectFlag) return [...out, ...args];

  const jsonIdx = args.findIndex((a) => !a.startsWith("-") && a.endsWith(".json"));
  const jsonArg = jsonIdx >= 0 ? args[jsonIdx] : undefined;
  if (jsonArg !== undefined) {
    const rest = args.filter((_, i) => i !== jsonIdx);
    return [...out, "-p", jsonArg, ...rest];
  }
  if (existsSync(join(root, "tsconfig.json"))) {
    return [...out, "-p", "tsconfig.json", ...args];
  }
  return [...out, ...args];
}

export const tscProvider: TaskProvider = {
  id: "tsc",
  verb: "typecheck",
  binary: "tsc",
  installHint: "pnpm add -D typescript@^7.0.2 (or @typescript/native-preview)",
  detect: (root) => {
    if (!isTypescriptProject(root)) {
      return { applicable: false, reason: "no TypeScript project or tsconfig.json" };
    }
    const { version, major } = typescriptVersionInfo(root);
    if (major !== undefined && major >= 7) {
      return { applicable: true, reason: `typescript ${version} (native >= 7)` };
    }
    if (version !== undefined) {
      return { applicable: true, reason: `typescript ${version} (< 7, legacy JS)` };
    }
    return { applicable: true, reason: "TypeScript project (default)" };
  },
  priority: (root) => {
    const { major } = typescriptVersionInfo(root);
    return major !== undefined && major >= 7 ? 20 : 5;
  },
  command: (root, args) => tsTypecheckArgs(root, args),
  warning: (root) => {
    const { version, major } = typescriptVersionInfo(root);
    if (major !== undefined && major < 7) {
      return `guardrails typecheck: warning — typescript ${version} is JS-based; upgrade to typescript >= 7 (7.0.2+) or @typescript/native-preview (tsgo) for native speed`;
    }
    return undefined;
  },
};

export const tsgoProvider: TaskProvider = {
  id: "tsgo",
  verb: "typecheck",
  binary: "tsgo",
  installHint: "pnpm add -D @typescript/native-preview",
  detect: (root) =>
    hasTsgoSignal(root)
      ? { applicable: true, reason: "@typescript/native-preview (tsgo) detected" }
      : { applicable: false, reason: "no @typescript/native-preview dependency or tsgo binary" },
  priority: (root) => {
    const { major } = typescriptVersionInfo(root);
    return major !== undefined && major >= 7 ? 10 : 15;
  },
  command: (root, args) => tsTypecheckArgs(root, args),
};

export const cargoCheckProvider: TaskProvider = {
  id: "cargo",
  verb: "typecheck",
  binary: "cargo",
  installHint: "install Rust: mise use -g rust@latest",
  detect: (root) =>
    hasLanguage(languagesOrDetected(root), "rust")
      ? { applicable: true, reason: "Rust language enabled (Cargo.toml)" }
      : { applicable: false, reason: "Rust language not enabled" },
  priority: () => 2,
  command: (_root, args) => ["check", ...args],
};

export const TYPECHECK_PROVIDERS: readonly TaskProvider[] = [
  tscProvider,
  tsgoProvider,
  cargoCheckProvider,
];
