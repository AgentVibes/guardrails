import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { isTaskVerb, type TaskVerb } from "./types.js";

export class TaskConfigError extends Error {}

const TaskEntrySchema = z
  .object({
    provider: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .strict();

const BuildSectionSchema = z
  .object({
    command: z.string().min(1).optional(),
  })
  .loose();

export interface VerbConfig {
  provider?: string;
  command?: string;
  sourceKey: string;
}

export type TasksConfig = Partial<Record<TaskVerb, VerbConfig>>;

/**
 * Reads `[tasks.<verb>]` and `[build] command` from `.agentvibes/project.toml`.
 * Absent file or absent tables return `{}` (no config must work).
 */
export function readTasksConfig(root: string): TasksConfig {
  const path = join(root, ".agentvibes", "project.toml");
  if (!existsSync(path)) return {};
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new TaskConfigError(
      `${path} is not valid TOML: ${(err as Error).message.split("\n")[0]}`,
    );
  }

  const out: TasksConfig = {};
  if (doc.tasks !== undefined) {
    if (typeof doc.tasks !== "object" || doc.tasks === null || Array.isArray(doc.tasks)) {
      throw new TaskConfigError(`${path}: [tasks] must be a table`);
    }
    for (const [verb, raw] of Object.entries(doc.tasks as Record<string, unknown>)) {
      if (!isTaskVerb(verb)) {
        throw new TaskConfigError(
          `${path}: unknown task verb [tasks.${verb}] (expected: build, lint, typecheck, test, format, run)`,
        );
      }
      const parsed = TaskEntrySchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join(".") ?? "";
        throw new TaskConfigError(
          `${path}: [tasks.${verb}]${where === "" ? "" : ` ${where}`}: ${issue?.message ?? "invalid"}`,
        );
      }
      out[verb] = {
        ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
        ...(parsed.data.command !== undefined ? { command: parsed.data.command } : {}),
        sourceKey: `[tasks.${verb}]`,
      };
    }
  }

  // `[build] command = "..."` always wins over detected build providers.
  if (doc.build !== undefined) {
    if (typeof doc.build !== "object" || doc.build === null || Array.isArray(doc.build)) {
      throw new TaskConfigError(`${path}: [build] must be a table`);
    }
    const parsedBuild = BuildSectionSchema.safeParse(doc.build);
    if (!parsedBuild.success) {
      const issue = parsedBuild.error.issues[0];
      throw new TaskConfigError(`${path}: [build]: ${issue?.message ?? "invalid"}`);
    }
    if (parsedBuild.data.command !== undefined) {
      out.build = {
        ...out.build,
        command: parsedBuild.data.command,
        sourceKey: "[build] command",
      };
    }
  }

  return out;
}
