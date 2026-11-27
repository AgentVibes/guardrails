import type { TaskContext, TaskProvider } from "./types.js";

/** Node >= 22.18.0 or >= 23.6.0 (including 24+) supports unflagged native type stripping. */
export function supportsNativeTypeStripping(version: string = process.version): boolean {
  const m = version.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

function nodeVer(ctx?: TaskContext): string {
  return ctx?.nodeVersion ?? process.version;
}

export const nodeRunProvider: TaskProvider = {
  id: "node",
  verb: "run",
  binary: "node",
  installHint: "mise use -g node@22 (22.18+ or 23.6+ for native TypeScript)",
  detect: (_root, ctx) => {
    const v = nodeVer(ctx);
    return supportsNativeTypeStripping(v)
      ? { applicable: true, reason: `node ${v} supports native type stripping (>= 22.18/23.6)` }
      : { applicable: false, reason: `node ${v} lacks unflagged type stripping (< 22.18/23.6)` };
  },
  priority: () => 20,
  command: (_root, args) => (args.length > 0 ? [...args] : ["<file>"]),
};

export const bunRunProvider: TaskProvider = {
  id: "bun",
  verb: "run",
  binary: "bun",
  installHint: "curl -fsSL https://bun.sh/install | bash (or mise use -g bun@latest)",
  detect: () => ({ applicable: true, reason: "bun runs TypeScript and JavaScript directly" }),
  priority: () => 10,
  command: (_root, args) => (args.length > 0 ? [...args] : ["<file>"]),
};

export const RUN_PROVIDERS: readonly TaskProvider[] = [nodeRunProvider, bunRunProvider];
