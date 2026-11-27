import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { isPlaceholderReason } from "./overrideDeclarations.js";
import { toolchainConfig } from "./packagePaths.js";
import { installedPackageVersion, parseMajorVersion } from "./tasks/resolveBinary.js";

export type ToolchainSeverity = "warning" | "error" | "off";

export interface ToolchainAllowEntry {
  tool: string;
  reason: string;
  hasReason: boolean;
}

export interface ToolchainConfig {
  severity: ToolchainSeverity;
  allow: ToolchainAllowEntry[];
}

export class ToolchainConfigError extends Error {}

const AllowEntrySchema = z
  .object({
    tool: z.string().min(1),
    reason: z.string().default(""),
  })
  .strict();

const ToolchainTableSchema = z
  .object({
    severity: z.enum(["warning", "error", "off"]).default("warning"),
    allow: z.array(AllowEntrySchema).default([]),
  })
  .strict();

const SlowToolRuleSchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).default([]),
  packages: z.array(z.string()).default([]),
  packagePrefixes: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  maxMajorExclusive: z.number().optional(),
  replacement: z.string(),
  why: z.string(),
});

type SlowToolRule = z.infer<typeof SlowToolRuleSchema>;

const ToolchainTableFileSchema = z.object({
  tools: z.array(SlowToolRuleSchema),
});

let cachedRules: readonly SlowToolRule[] | undefined;

function loadToolRules(): readonly SlowToolRule[] {
  if (cachedRules !== undefined) return cachedRules;
  const parsed = ToolchainTableFileSchema.parse(JSON.parse(readFileSync(toolchainConfig, "utf8")));
  cachedRules = parsed.tools;
  return cachedRules;
}

export function readToolchainConfig(root: string): ToolchainConfig {
  const path = join(root, ".agentvibes", "project.toml");
  if (!existsSync(path)) return { severity: "warning", allow: [] };
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ToolchainConfigError(
      `${path} is not valid TOML: ${(err as Error).message.split("\n")[0]}`,
    );
  }
  if (doc.toolchain === undefined) return { severity: "warning", allow: [] };
  const parsed = ToolchainTableSchema.safeParse(doc.toolchain);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    throw new ToolchainConfigError(
      `${path}: [toolchain]${where === "" ? "" : ` ${where}`}: ${issue?.message ?? "invalid"}`,
    );
  }
  return {
    severity: parsed.data.severity,
    allow: parsed.data.allow.map((a) => ({
      tool: a.tool,
      reason: a.reason.trim(),
      hasReason: a.reason.trim() !== "" && !isPlaceholderReason(a.reason),
    })),
  };
}

export type ToolchainFindingKind = "script-bypass" | "slow-tool";

export interface ToolchainFinding {
  kind: ToolchainFindingKind;
  tool: string;
  aliases: string[];
  file: string;
  line?: number;
  where: string;
  replacement: string;
  detail: string;
}

export interface ToolchainReport {
  severity: ToolchainSeverity;
  findings: ToolchainFinding[];
  allowed: (ToolchainAllowEntry & { matched: boolean })[];
  withoutReason: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".claude",
]);

function walkPackageJsons(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && entry === "package.json") {
        out.push(relative(root, full).split(sep).join("/"));
      } else if (st.isDirectory() && !SKIP_DIRS.has(entry)) {
        visit(full);
      }
    }
  };
  visit(root);
  return out.sort();
}

function trackedPackageJsons(root: string): string[] {
  const res = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!res.error && res.status === 0) {
    const tracked = res.stdout
      .split("\0")
      .filter((p) => p !== "")
      .filter(
        (p) =>
          (p === "package.json" || p.endsWith("/package.json")) &&
          !p.split("/").includes("node_modules"),
      )
      .sort();
    if (tracked.length > 0) return tracked;
  }
  return walkPackageJsons(root);
}

const TASK_SCRIPT_VERBS = ["build", "lint", "typecheck", "test", "format"] as const;

interface ParsedPkg {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

function readPackageJson(absPath: string): ParsedPkg | undefined {
  try {
    const raw = JSON.parse(readFileSync(absPath, "utf8")) as {
      dependencies?: unknown;
      devDependencies?: unknown;
      scripts?: unknown;
    };
    const asStringMap = (v: unknown): Record<string, string> => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "string") out[k] = val;
      }
      return out;
    };
    return {
      dependencies: asStringMap(raw.dependencies),
      devDependencies: asStringMap(raw.devDependencies),
      scripts: asStringMap(raw.scripts),
    };
  } catch {
    return undefined;
  }
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RUNNER_PREFIX = new Set(["npx", "pnpx", "bunx", "exec", "dlx"]);
const PKG_MANAGER = new Set(["pnpm", "npm", "yarn", "bun"]);

function extractCommandNames(scriptText: string): string[] {
  const found: string[] = [];
  const segments = scriptText.split(/&&|\|\||[;|\n]/);
  for (const seg of segments) {
    const tokens = seg
      .trim()
      .split(/\s+/)
      .filter((t) => t !== "");
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === undefined) break;
      if (ENV_ASSIGN.test(tok) || RUNNER_PREFIX.has(tok)) {
        i += 1;
        continue;
      }
      if (PKG_MANAGER.has(tok)) {
        const next = tokens[i + 1];
        if (next === "exec" || next === "dlx" || next === "x") {
          i += 2;
          continue;
        }
        break;
      }
      found.push(basename(tok));
      break;
    }
  }
  return found;
}

function isTypescriptTooOld(
  root: string,
  pkgDir: string,
  spec: string,
  allDeps: Record<string, string>,
  rootHasNativePreview: boolean,
): { flagged: boolean; detail: string } {
  if (rootHasNativePreview || allDeps["@typescript/native-preview"] !== undefined) {
    return { flagged: false, detail: "" };
  }
  const installed =
    installedPackageVersion(pkgDir, "typescript") ?? installedPackageVersion(root, "typescript");
  const versionStr = installed ?? spec;
  const major = parseMajorVersion(versionStr);
  if (major !== undefined && major < 7) {
    return {
      flagged: true,
      detail: `typescript ${spec}${installed !== undefined ? ` (installed ${installed})` : ""} is < 7`,
    };
  }
  return { flagged: false, detail: "" };
}

function scanPackageJson(
  root: string,
  relPath: string,
  rules: readonly SlowToolRule[],
  rootHasNativePreview: boolean,
): ToolchainFinding[] {
  const absPath = join(root, relPath);
  const pkg = readPackageJson(absPath);
  if (pkg === undefined) return [];
  const out: ToolchainFinding[] = [];

  for (const verb of TASK_SCRIPT_VERBS) {
    const body = pkg.scripts[verb];
    if (body === undefined || body.trim() === "") continue;
    if (!new RegExp(`\\bguardrails\\s+${verb}\\b`).test(body)) {
      out.push({
        kind: "script-bypass",
        tool: `script:${verb}`,
        aliases: [verb],
        file: relPath,
        where: `${relPath}#scripts.${verb}`,
        replacement: `guardrails ${verb}`,
        detail: `script "${verb}" (${body}) does not call \`guardrails ${verb}\``,
      });
    }
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pkgDir = dirname(absPath);
  const scriptCommands = new Set(Object.values(pkg.scripts).flatMap(extractCommandNames));

  for (const rule of rules) {
    const matchedDeps = Object.keys(allDeps).filter(
      (dep) =>
        rule.packages.includes(dep) || rule.packagePrefixes.some((p) => dep.startsWith(p)),
    );
    const matchedCmds = rule.commands.filter((c) => scriptCommands.has(c));

    if (rule.maxMajorExclusive !== undefined) {
      const tsSpec = allDeps.typescript;
      if (tsSpec !== undefined) {
        const tsCheck = isTypescriptTooOld(root, pkgDir, tsSpec, allDeps, rootHasNativePreview);
        if (tsCheck.flagged) {
          out.push({
            kind: "slow-tool",
            tool: rule.id,
            aliases: rule.aliases,
            file: relPath,
            where: `${relPath} (typescript)`,
            replacement: rule.replacement,
            detail: `${tsCheck.detail} — upgrade to ${rule.replacement} (${rule.why})`,
          });
        }
      }
      continue;
    }

    if (matchedDeps.length > 0 || matchedCmds.length > 0) {
      const labels = [...new Set([...matchedDeps, ...matchedCmds])];
      out.push({
        kind: "slow-tool",
        tool: rule.id,
        aliases: [...new Set([...rule.aliases, ...matchedDeps, ...matchedCmds])],
        file: relPath,
        where: `${relPath} (${labels.join(", ")})`,
        replacement: rule.replacement,
        detail: `${labels.join(", ")} — use ${rule.replacement} (${rule.why})`,
      });
    }
  }

  return out;
}

function scanWorkflowFile(
  root: string,
  relPath: string,
  rules: readonly SlowToolRule[],
): ToolchainFinding[] {
  let text: string;
  try {
    text = readFileSync(join(root, relPath), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const out: ToolchainFinding[] = [];
  let blockIndent: number | undefined;

  const inspectCommandLine = (cmdText: string, lineNo: number): void => {
    const trimmed = cmdText.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const cmds = extractCommandNames(trimmed);
    for (const rule of rules) {
      const hit = rule.commands.find((c) => cmds.includes(c));
      if (hit === undefined) continue;
      out.push({
        kind: "slow-tool",
        tool: rule.id,
        aliases: [...new Set([...rule.aliases, hit])],
        file: relPath,
        line: lineNo,
        where: `${relPath}:${lineNo}`,
        replacement: rule.replacement,
        detail: `workflow runs "${hit}" — use ${rule.replacement} (${rule.why})`,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const indent = raw.search(/\S/);
    if (blockIndent !== undefined) {
      if (indent < 0) continue;
      if (indent > blockIndent) {
        inspectCommandLine(raw, lineNo);
        continue;
      }
      blockIndent = undefined;
    }
    const runMatch = raw.match(/^(\s*(?:-\s+)?)run:\s*(.*)$/);
    if (runMatch === null) continue;
    const prefix = runMatch[1] ?? "";
    const body = (runMatch[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(body)) {
      blockIndent = prefix.length;
    } else {
      inspectCommandLine(body, lineNo);
    }
  }
  return out;
}

function scanWorkflows(root: string, rules: readonly SlowToolRule[]): ToolchainFinding[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `.github/workflows/${f}`);
  return files.flatMap((f) => scanWorkflowFile(root, f, rules));
}

function matchesAllow(finding: ToolchainFinding, allow: ToolchainAllowEntry): boolean {
  return allow.tool === finding.tool || finding.aliases.includes(allow.tool);
}

export function scanToolchain(root: string): ToolchainReport {
  const config = readToolchainConfig(root);
  if (config.severity === "off") {
    return {
      severity: "off",
      findings: [],
      allowed: config.allow.map((a) => ({ ...a, matched: false })),
      withoutReason: 0,
    };
  }

  const rules = loadToolRules();
  const rootPkg = readPackageJson(join(root, "package.json"));
  const rootHasNativePreview =
    rootPkg?.dependencies["@typescript/native-preview"] !== undefined ||
    rootPkg?.devDependencies["@typescript/native-preview"] !== undefined;

  const pkgFiles = trackedPackageJsons(root);
  const rawFindings: ToolchainFinding[] = [
    ...pkgFiles.flatMap((f) => scanPackageJson(root, f, rules, rootHasNativePreview)),
    ...scanWorkflows(root, rules),
  ];

  const usedAllows = new Set<number>();
  const active: ToolchainFinding[] = [];
  for (const f of rawFindings) {
    const validIdx = config.allow.findIndex((a, idx) => {
      if (!matchesAllow(f, a)) return false;
      usedAllows.add(idx);
      return a.hasReason;
    });
    if (validIdx < 0) active.push(f);
  }

  const withoutReason = config.allow.filter((a) => !a.hasReason).length;
  return {
    severity: config.severity,
    findings: active,
    allowed: config.allow.map((a, idx) => ({ ...a, matched: usedAllows.has(idx) })),
    withoutReason,
  };
}
