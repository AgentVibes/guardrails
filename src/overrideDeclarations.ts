import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// `[[override]]` in .agentvibes/project.toml: the written reason for every way
// a repo deviates from the canon that is configured rather than commented.
//
//   [[override]]
//   kind   = "biome-rule"
//   rule   = "suspicious/noUndeclaredEnvVars"
//   paths  = ["**/scripts/**"]
//   reason = "deploy scripts read env set by the runner, not declared in turbo.json"
//
// Inline suppressions carry their reason in the comment itself
// (`// ast-grep-ignore: <rule> -- <why>`) and are never declared here.
//
// This module only READS the declarations. Which deviations exist, and which
// declaration answers which deviation, is overrides.ts; the biome preset check
// (presetDrift.ts) asks it whether a non-preset biome rule is declared.

/** `.agentvibes/project.toml` cannot be read the way this package needs. */
export class OverrideConfigError extends Error {}

/** Kinds a repo may declare. Inline suppressions are not declarable: their reason lives in the comment. */
export const DECLARABLE_KINDS = [
  "verify-scope",
  "biome-rule",
  "repo-rule-shadow",
  "metrics-limit",
] as const;
export type DeclarableKind = (typeof DECLARABLE_KINDS)[number];

const reasonField = z.string().default("");

const Declaration = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("verify-scope"), rule: z.string().min(1), reason: reasonField })
    .strict(),
  z
    .object({
      kind: z.literal("biome-rule"),
      /** `<group>/<rule>`, e.g. `suspicious/noConsole` */
      rule: z.string().regex(/^[A-Za-z]+\/[A-Za-z]+$/, "biome rule must be written <group>/<rule>"),
      /** The override entry's `includes`, exactly. Omitted = the repo-wide `linter.rules`. */
      paths: z.array(z.string()).default([]),
      reason: reasonField,
    })
    .strict(),
  z
    .object({ kind: z.literal("repo-rule-shadow"), rule: z.string().min(1), reason: reasonField })
    .strict(),
  z
    .object({ kind: z.literal("metrics-limit"), rule: z.string().min(1), reason: reasonField })
    .strict(),
]);
export type OverrideDeclaration = z.infer<typeof Declaration> & { index: number };

const OverrideTable = z.array(z.unknown());

/** Every `[[override]]` the repo declares, in file order; [] when the file or the table is absent. */
export function readOverrideDeclarations(root: string): OverrideDeclaration[] {
  const path = join(root, ".agentvibes", "project.toml");
  // ast-grep-ignore: silent-default-return -- no project file means no declarations; [] is the real answer, and every caller treats it as "nothing declared"
  if (!existsSync(path)) return [];
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new OverrideConfigError(
      `${path} is not valid TOML: ${(e as Error).message.split("\n")[0]}`,
    );
  }
  // ast-grep-ignore: silent-default-return -- a file without [[override]] declares nothing; a malformed table throws below instead
  if (doc.override === undefined) return [];
  const table = OverrideTable.safeParse(doc.override);
  if (!table.success) {
    throw new OverrideConfigError(
      `${path}: \`override\` must be an array of tables, written [[override]]`,
    );
  }
  return table.data.map((entry, index) => {
    const parsed = Declaration.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") ?? "";
      throw new OverrideConfigError(
        `${path}: [[override]] #${index + 1}${where === "" ? "" : ` ${where}`}: ${issue?.message ?? "invalid"} (kinds: ${DECLARABLE_KINDS.join(", ")})`,
      );
    }
    return { ...parsed.data, index };
  });
}

/** Same members, any order. */
export function samePaths(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((p) => set.has(p));
}

/** The declaration of one biome rule at one path set, if the repo wrote it. */
export function findBiomeDeclaration(
  declarations: readonly OverrideDeclaration[],
  rule: string,
  paths: readonly string[],
): OverrideDeclaration | undefined {
  return declarations.find(
    (d) => d.kind === "biome-rule" && d.rule === rule && samePaths(d.paths, paths),
  );
}
