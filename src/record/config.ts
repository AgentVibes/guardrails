import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// Where a run is recorded, if anywhere.
//
//   GUARDRAILS_RECORD unset, "" or "0"  → nothing is recorded
//   GUARDRAILS_RECORD=1                 → the configured or default database
//   GUARDRAILS_RECORD=<path>            → that database
//
// The configured database is `[record] db = "<path>"` in
// $XDG_CONFIG_HOME/agentvibes/guardrails.toml (default ~/.config/…). The
// default database is $XDG_STATE_HOME/agentvibes/guardrails.sqlite (default
// ~/.local/state/…). Every path is computed at run time; `~/` is expanded.
// `guardrails snapshot` records whatever the variable says, because recording
// is the whole point of that command.

export class RecordConfigError extends Error {}

export type RecordTarget =
  | { status: "off" }
  | { status: "on"; db: string; source: "env-path" | "config" | "default" };

const UserConfig = z
  .object({
    record: z
      .object({ db: z.string().min(1) })
      .partial()
      .strict()
      .default({}),
  })
  .loose();

type Env = Readonly<Record<string, string | undefined>>;

function expand(path: string, env: Env): string {
  const home = env.HOME ?? homedir();
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

function xdg(env: Env, key: "XDG_CONFIG_HOME" | "XDG_STATE_HOME", fallback: string): string {
  const v = env[key];
  // The XDG spec: a relative value is invalid and must be ignored.
  if (v !== undefined && v !== "" && isAbsolute(v)) return v;
  return join(env.HOME ?? homedir(), fallback);
}

export function userConfigPath(env: Env = process.env): string {
  return join(xdg(env, "XDG_CONFIG_HOME", ".config"), "agentvibes", "guardrails.toml");
}

export function defaultDbPath(env: Env = process.env): string {
  return join(xdg(env, "XDG_STATE_HOME", ".local/state"), "agentvibes", "guardrails.sqlite");
}

/** `[record] db` from the user config, expanded; undefined when unset. Throws on a bad file. */
export function configuredDb(env: Env = process.env): string | undefined {
  const path = userConfigPath(env);
  if (!existsSync(path)) return undefined;
  let doc: unknown;
  try {
    doc = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RecordConfigError(
      `${path} is not valid TOML: ${(err as Error).message.split("\n")[0]}`,
    );
  }
  const parsed = UserConfig.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RecordConfigError(
      `${path}: [record] ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`,
    );
  }
  const db = parsed.data.record.db;
  return db === undefined ? undefined : expand(db, env);
}

/** The database this run records to. `force` (snapshot) records even when the variable is unset. */
export function recordTarget(env: Env = process.env, force = false): RecordTarget {
  const raw = (env.GUARDRAILS_RECORD ?? "").trim();
  const off = raw === "" || raw === "0";
  if (off && !force) return { status: "off" };
  if (!off && raw !== "1") return { status: "on", db: expand(raw, env), source: "env-path" };
  const configured = configuredDb(env);
  return configured === undefined
    ? { status: "on", db: defaultDbPath(env), source: "default" }
    : { status: "on", db: configured, source: "config" };
}
