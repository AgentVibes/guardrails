import { hasLanguage, languagesOrDetected } from "../lang/languages.js";
import { hasAnyFile } from "./resolveBinary.js";
import type { TaskProvider } from "./types.js";

const DPRINT_FILES = ["dprint.json", "dprint.jsonc", ".dprint.json"] as const;

export const biomeFormatProvider: TaskProvider = {
  id: "biome",
  verb: "format",
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
  command: (_root, args) => {
    if (args.length === 0) return ["format", "--write", "."];
    if (args.some((a) => !a.startsWith("-"))) return ["format", "--write", ...args];
    return ["format", "--write", ".", ...args];
  },
};

export const dprintFormatProvider: TaskProvider = {
  id: "dprint",
  verb: "format",
  binary: "dprint",
  installHint: "mise use -g dprint@latest (or pnpm add -D dprint)",
  detect: (root) => {
    const cfg = hasAnyFile(root, DPRINT_FILES);
    return cfg !== undefined
      ? { applicable: true, reason: `${cfg} present` }
      : { applicable: false, reason: "no dprint.json found" };
  },
  priority: (root) => (hasAnyFile(root, ["biome.json", "biome.jsonc"]) !== undefined ? 5 : 15),
  command: (_root, args) => ["fmt", ...args],
};

export const FORMAT_PROVIDERS: readonly TaskProvider[] = [
  biomeFormatProvider,
  dprintFormatProvider,
];
