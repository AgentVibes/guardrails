import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { OverrideConfigError } from "../overrideDeclarations.js";
import { cargoRoots } from "./rust/cargoManifest.js";

// Which languages a checkout is written in, and so which adapters run.
//
//   typescript — a package.json or tsconfig.json at the repo root;
//   rust       — a Cargo.toml anywhere in the checkout (a Cargo workspace
//                inside a TypeScript monorepo makes it mixed).
//
// A checkout with neither is TypeScript: that is what guardrails did before it
// knew other languages, and it keeps every existing repo and test unchanged.
//
// `[languages] enabled = ["typescript"]` in .agentvibes/project.toml replaces
// detection. The list is validated; an unknown name or an empty list is a
// config error (OverrideConfigError, the project.toml error every command
// already reports), never a silent fallback.

export const LANGUAGE_IDS = ["typescript", "rust"] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

export interface LanguageSet {
  languages: LanguageId[];
  /** Where the list came from: the project file, detection, or the default. */
  source: "config" | "detected" | "default";
  /** One line of evidence per language. */
  evidence: string[];
}

const LanguagesTable = z
  .object({ enabled: z.array(z.enum(LANGUAGE_IDS)).min(1, "list at least one language") })
  .strict();

/** `[languages] enabled`, or undefined when the repo does not set it. Throws OverrideConfigError when malformed. */
export function configuredLanguages(root: string): LanguageId[] | undefined {
  const path = join(root, ".agentvibes", "project.toml");
  if (!existsSync(path)) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new OverrideConfigError(
      `${path} is not valid TOML: ${(e as Error).message.split("\n")[0]}`,
    );
  }
  if (doc.languages === undefined) return undefined;
  const parsed = LanguagesTable.safeParse(doc.languages);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    throw new OverrideConfigError(
      `${path}: [languages]${where === "" ? "" : ` ${where}`}: ${issue?.message ?? "invalid"} (languages: ${LANGUAGE_IDS.join(", ")})`,
    );
  }
  return [...new Set(parsed.data.enabled)];
}

/** What detection finds, without the project file. */
export function detectLanguages(root: string): { id: LanguageId; evidence: string }[] {
  const out: { id: LanguageId; evidence: string }[] = [];
  const tsMarker = ["package.json", "tsconfig.json"].find((f) => existsSync(join(root, f)));
  if (tsMarker !== undefined) out.push({ id: "typescript", evidence: `${tsMarker} at the root` });
  const cargo = cargoRoots(root);
  if (cargo.length > 0) {
    out.push({
      id: "rust",
      evidence: `Cargo.toml at ${cargo.map((c) => c.rel || "the repo root").join(", ")}`,
    });
  }
  return out;
}

/** The languages guardrails runs for in `root`. Throws OverrideConfigError on a malformed [languages]. */
export function resolveLanguages(root: string): LanguageSet {
  const configured = configuredLanguages(root);
  if (configured !== undefined) {
    return {
      languages: configured,
      source: "config",
      evidence: configured.map((l) => `${l}: [languages] enabled in .agentvibes/project.toml`),
    };
  }
  const detected = detectLanguages(root);
  if (detected.length === 0) {
    return {
      languages: ["typescript"],
      source: "default",
      evidence: ["typescript: nothing detected, TypeScript is the default"],
    };
  }
  return {
    languages: detected.map((d) => d.id),
    source: "detected",
    evidence: detected.map((d) => `${d.id}: ${d.evidence}`),
  };
}

/**
 * The languages for a report that must not fail (wiring, doctor): the
 * configured set, or detection when the project file is malformed. The
 * malformed file is reported by the commands that gate on it.
 */
export function languagesOrDetected(root: string): LanguageId[] {
  try {
    return resolveLanguages(root).languages;
  } catch (err) {
    if (!(err instanceof OverrideConfigError)) throw err;
    const detected = detectLanguages(root).map((d) => d.id);
    return detected.length > 0 ? detected : ["typescript"];
  }
}

export function hasLanguage(languages: readonly LanguageId[], id: LanguageId): boolean {
  return languages.includes(id);
}
