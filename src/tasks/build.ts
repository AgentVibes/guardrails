import { hasLanguage, languagesOrDetected } from "../lang/languages.js";
import { hasAnyFile, readRootPackage } from "./resolveBinary.js";
import type { TaskProvider } from "./types.js";

const NEXT_CONFIGS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
] as const;

const VITE_CONFIGS = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
] as const;

const TSDOWN_CONFIGS = [
  "tsdown.config.ts",
  "tsdown.config.mts",
  "tsdown.config.js",
  "tsdown.config.mjs",
] as const;

export const nextBuildProvider: TaskProvider = {
  id: "next",
  verb: "build",
  binary: "next",
  installHint: "pnpm add -D next",
  detect: (root) => {
    const pkg = readRootPackage(root);
    if (pkg?.allDeps.next !== undefined) {
      return { applicable: true, reason: "next in package.json" };
    }
    const cfg = hasAnyFile(root, NEXT_CONFIGS);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    return { applicable: false, reason: "no next dependency or config" };
  },
  priority: () => 30,
  command: (_root, args) => {
    const hasBundlerFlag = args.some(
      (a) => a === "--turbopack" || a === "--turbo" || a === "--webpack",
    );
    return ["build", ...(hasBundlerFlag ? [] : ["--turbopack"]), ...args];
  },
};

export const viteBuildProvider: TaskProvider = {
  id: "vite",
  verb: "build",
  binary: "vite",
  installHint: "pnpm add -D vite",
  detect: (root) => {
    const pkg = readRootPackage(root);
    if (pkg?.allDeps.vite !== undefined) {
      return { applicable: true, reason: "vite in package.json" };
    }
    const cfg = hasAnyFile(root, VITE_CONFIGS);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    return { applicable: false, reason: "no vite dependency or config" };
  },
  priority: () => 20,
  command: (_root, args) => ["build", ...args],
};

export const tsdownBuildProvider: TaskProvider = {
  id: "tsdown",
  verb: "build",
  binary: "tsdown",
  installHint: "pnpm add -D tsdown",
  detect: (root) => {
    const pkg = readRootPackage(root);
    if (pkg?.allDeps.tsdown !== undefined) {
      return { applicable: true, reason: "tsdown in package.json" };
    }
    const cfg = hasAnyFile(root, TSDOWN_CONFIGS);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    if (pkg?.exports !== undefined || pkg?.main !== undefined) {
      return { applicable: true, reason: "library package.json with exports/main" };
    }
    return { applicable: false, reason: "no tsdown config or library exports/main" };
  },
  priority: () => 10,
  command: (_root, args) => [...args],
};

export const cargoBuildProvider: TaskProvider = {
  id: "cargo",
  verb: "build",
  binary: "cargo",
  installHint: "install Rust: mise use -g rust@latest",
  detect: (root) =>
    hasLanguage(languagesOrDetected(root), "rust")
      ? { applicable: true, reason: "Rust language enabled (Cargo.toml)" }
      : { applicable: false, reason: "Rust language not enabled" },
  priority: () => 5,
  command: (_root, args) => ["build", ...args],
};

export const BUILD_PROVIDERS: readonly TaskProvider[] = [
  nextBuildProvider,
  viteBuildProvider,
  tsdownBuildProvider,
  cargoBuildProvider,
];
