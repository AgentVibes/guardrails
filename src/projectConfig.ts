import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// The typed reader for `.agentvibes/project.toml`. The older tables
// (`[verify]`, `[severity]`, `[deploy]`, `[leaks]`) keep their line reader in
// tomlTable.ts, so a file that reader used to tolerate does not start failing
// here. The tables this module owns need real TOML — integers, arrays, arrays
// of tables — so they get a real parser and a schema.
//
// Unknown tables (`[[deployment]]`, `[stack]` and whatever other tools keep in
// the same file) pass through untouched: the file is shared, and this package
// owns only its own keys.

/** The project file exists but this package cannot honour what it says. */
export class ProjectConfigError extends Error {}

export const DEFAULT_MAX_FILE_LINES = 500;

const MetricsTable = z
  .object({
    max_file_lines: z.number().int().positive().optional(),
  })
  .strict();

const ProjectFile = z
  .object({
    metrics: MetricsTable.optional(),
  })
  .passthrough();

export interface ProjectConfig {
  /** Absolute path of the file, or undefined when the repo has none. */
  path: string | undefined;
  metrics: {
    /** Files longer than this many lines count toward `filesOverLineLimit`. */
    maxFileLines: number;
    /** True when the repo set `max_file_lines` itself rather than taking the default. */
    maxFileLinesDeclared: boolean;
  };
  /** The parsed file, for readers of tables this module does not type. */
  raw: Record<string, unknown>;
}

export function projectTomlPath(root: string): string {
  return join(root, ".agentvibes", "project.toml");
}

/** Read and validate `.agentvibes/project.toml`; defaults when the file is absent. */
export function readProjectConfig(root: string): ProjectConfig {
  const path = projectTomlPath(root);
  if (!existsSync(path)) {
    return {
      path: undefined,
      metrics: { maxFileLines: DEFAULT_MAX_FILE_LINES, maxFileLinesDeclared: false },
      raw: {},
    };
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ProjectConfigError(
      `${path} is not valid TOML: ${(e as Error).message.split("\n")[0]}`,
    );
  }
  const parsed = ProjectFile.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : issue.path.join(".");
    throw new ProjectConfigError(
      `${path}: ${where === "" ? "" : `${where}: `}${issue?.message ?? "invalid"}`,
    );
  }
  const declared = parsed.data.metrics?.max_file_lines;
  return {
    path,
    metrics: {
      maxFileLines: declared ?? DEFAULT_MAX_FILE_LINES,
      maxFileLinesDeclared: declared !== undefined,
    },
    raw,
  };
}
