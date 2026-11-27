import { hasLanguage, languagesOrDetected } from "../lang/languages.js";
import { findLocalBin, hasAnyFile, hasBinary, readRootPackage } from "./resolveBinary.js";
import type { TaskProvider } from "./types.js";

const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
] as const;

const BUN_FILES = ["bun.lock", "bun.lockb", "bunfig.toml"] as const;

export const vitestProvider: TaskProvider = {
  id: "vitest",
  verb: "test",
  binary: "vitest",
  installHint: "pnpm add -D vitest",
  detect: (root) => {
    const pkg = readRootPackage(root);
    if (pkg?.allDeps.vitest !== undefined) {
      return { applicable: true, reason: "vitest in package.json" };
    }
    const cfg = hasAnyFile(root, VITEST_CONFIGS);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    if (findLocalBin(root, "vitest") !== undefined) {
      return { applicable: true, reason: "vitest in node_modules/.bin" };
    }
    return { applicable: false, reason: "no vitest dependency or config" };
  },
  priority: () => 30,
  command: (_root, args) => {
    const first = args[0];
    if (first === "run" || first === "watch") return [...args];
    return ["run", ...args];
  },
};

export const bunTestProvider: TaskProvider = {
  id: "bun",
  verb: "test",
  binary: "bun",
  installHint: "curl -fsSL https://bun.sh/install | bash (or mise use -g bun@latest)",
  detect: (root, ctx) => {
    const cfg = hasAnyFile(root, BUN_FILES);
    if (cfg !== undefined) return { applicable: true, reason: `${cfg} present` };
    const pkg = readRootPackage(root);
    if (pkg?.allDeps["bun-types"] !== undefined || pkg?.allDeps["@types/bun"] !== undefined) {
      return { applicable: true, reason: "bun types in package.json" };
    }
    if (
      hasLanguage(languagesOrDetected(root), "typescript") &&
      (ctx?.hasBinary ?? hasBinary)(root, "bun")
    ) {
      return { applicable: true, reason: "bun available on PATH" };
    }
    return { applicable: false, reason: "no bun lockfile/config or bun binary" };
  },
  priority: () => 20,
  command: (_root, args) => ["test", ...args],
};

export const nodeTestProvider: TaskProvider = {
  id: "node",
  verb: "test",
  binary: "node",
  installHint: "mise use -g node@22",
  detect: (root) =>
    hasLanguage(languagesOrDetected(root), "typescript")
      ? { applicable: true, reason: "TypeScript/Node project (default fallback)" }
      : { applicable: false, reason: "no Node/TypeScript project" },
  priority: () => 10,
  command: (_root, args) => ["--test", ...args],
};

export const cargoNextestProvider: TaskProvider = {
  id: "cargo-nextest",
  verb: "test",
  binary: "cargo-nextest",
  installHint: "cargo install cargo-nextest (or mise use -g cargo-nextest@latest)",
  detect: (root, ctx) => {
    if (!hasLanguage(languagesOrDetected(root), "rust")) {
      return { applicable: false, reason: "Rust language not enabled" };
    }
    return (ctx?.hasBinary ?? hasBinary)(root, "cargo-nextest")
      ? { applicable: true, reason: "Rust project with cargo-nextest available" }
      : { applicable: false, reason: "cargo-nextest not installed" };
  },
  priority: () => 15,
  command: (_root, args) => ["nextest", "run", ...args],
};

export const cargoTestProvider: TaskProvider = {
  id: "cargo-test",
  verb: "test",
  binary: "cargo",
  installHint: "install Rust: mise use -g rust@latest",
  detect: (root) =>
    hasLanguage(languagesOrDetected(root), "rust")
      ? { applicable: true, reason: "Rust language enabled (Cargo.toml)" }
      : { applicable: false, reason: "Rust language not enabled" },
  priority: () => 5,
  command: (_root, args) => ["test", ...args],
};

export const TEST_PROVIDERS: readonly TaskProvider[] = [
  vitestProvider,
  bunTestProvider,
  nodeTestProvider,
  cargoNextestProvider,
  cargoTestProvider,
];
