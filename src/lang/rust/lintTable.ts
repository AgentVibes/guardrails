import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { packageRoot } from "../../packagePaths.js";

// The Clippy canon (configs/rust-lints.toml) and the comparison of a repo's
// Cargo lint table against it. Pure: a parsed table in, gaps and overrides
// out, so it is unit-tested without a toolchain.

export const LEVELS = ["allow", "warn", "deny", "forbid"] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { allow: 0, warn: 1, deny: 2, forbid: 3 };

/** Clippy's lint groups: an entry with one of these names sets many lints at once. */
export const CLIPPY_GROUPS = new Set([
  "all",
  "cargo",
  "complexity",
  "correctness",
  "nursery",
  "pedantic",
  "perf",
  "restriction",
  "style",
  "suspicious",
]);

export interface LintSetting {
  level: Level;
  priority: number;
}

const LintValue = z.union([
  z.enum(LEVELS).transform((level) => ({ level, priority: 0 })),
  z
    .object({ level: z.enum(LEVELS), priority: z.number().int().default(0) })
    .loose()
    .transform((v) => ({ level: v.level, priority: v.priority })),
]);

/** tool (`rust`, `clippy`, `rustdoc`) → lint name → setting. */
export type LintTables = Record<string, Record<string, LintSetting>>;

/** One unreadable entry: reported, never thrown, so one typo does not hide the rest of the table. */
export interface LintTableProblem {
  tool: string;
  name: string;
  message: string;
}

export function parseLintTables(raw: Record<string, Record<string, unknown>>): {
  tables: LintTables;
  problems: LintTableProblem[];
} {
  const tables: LintTables = {};
  const problems: LintTableProblem[] = [];
  for (const [tool, entries] of Object.entries(raw)) {
    const table: Record<string, LintSetting> = {};
    for (const [name, value] of Object.entries(entries)) {
      const parsed = LintValue.safeParse(value);
      if (parsed.success) table[name] = parsed.data;
      else
        problems.push({
          tool,
          name,
          message: `expected a level (${LEVELS.join(", ")}) or { level, priority }`,
        });
    }
    tables[tool] = table;
  }
  return { tables, problems };
}

const CanonFile = z.object({
  workspace: z.object({ lints: z.record(z.string(), z.record(z.string(), z.unknown())) }),
});

export const CANON_PATH = join(packageRoot, "configs", "rust-lints.toml");

/** The canon table, parsed from the shipped file. */
export function canonLints(): LintTables {
  const doc = CanonFile.parse(parseToml(readFileSync(CANON_PATH, "utf8")));
  const { tables, problems } = parseLintTables(doc.workspace.lints);
  if (problems.length > 0) {
    throw new Error(`${CANON_PATH}: ${problems.map((p) => `${p.tool}.${p.name}`).join(", ")}`);
  }
  return tables;
}

/** `clippy::unwrap_used`, `unsafe_code` (rustc lints are written bare, as in source). */
export function lintName(tool: string, name: string): string {
  return tool === "rust" ? name : `${tool}::${name}`;
}

/** A lint the table sets weaker than the canon, or to `allow`. */
export interface LintOverride {
  tool: string;
  name: string;
  level: Level;
  /** The canon's level, when the canon names this lint. */
  canon: Level | undefined;
}

export interface LintComparison {
  /** What keeps the table from meeting the canon: missing, too weak, or a group without priority -1. */
  gaps: string[];
  overrides: LintOverride[];
}

export function compareLints(repo: LintTables, canon: LintTables): LintComparison {
  const gaps: string[] = [];
  const overrides: LintOverride[] = [];
  for (const [tool, entries] of Object.entries(canon)) {
    for (const [name, want] of Object.entries(entries)) {
      const have = repo[tool]?.[name];
      const id = lintName(tool, name);
      if (have === undefined) {
        gaps.push(`${id} is not set (canon: ${want.level})`);
        continue;
      }
      if (RANK[have.level] < RANK[want.level]) {
        gaps.push(`${id} is ${have.level} (canon: ${want.level})`);
        overrides.push({ tool, name, level: have.level, canon: want.level });
      }
      if (want.priority < 0 && have.priority > want.priority) {
        gaps.push(
          `${id} has priority ${have.priority}; a group needs priority ${want.priority} or lower so single lints can override it`,
        );
      }
    }
  }
  for (const [tool, entries] of Object.entries(repo)) {
    for (const [name, have] of Object.entries(entries)) {
      if (canon[tool]?.[name] !== undefined) continue;
      if (have.level === "allow")
        overrides.push({ tool, name, level: have.level, canon: undefined });
    }
  }
  return { gaps, overrides };
}

/**
 * 1-based line of `name` inside the `[<prefix>.<tool>]` table of a manifest's
 * text; 0 when it cannot be placed (an inline-table form).
 */
export function lintLine(text: string, prefix: string, tool: string, name: string): number {
  const header = `[${prefix}.${tool}]`;
  const key = new RegExp(`^\\s*"?${name.replace(/[-]/g, "\\-")}"?\\s*=`);
  let inTable = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("[")) {
      inTable = line === header;
      continue;
    }
    if (inTable && key.test(line)) return i + 1;
  }
  return 0;
}
