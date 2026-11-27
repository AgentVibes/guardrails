import { match } from "ts-pattern";
import type { RunCollector } from "../record/record.js";
import { runTimedChild } from "../time.js";
import { BUILD_PROVIDERS } from "./build.js";
import { readTasksConfig, TaskConfigError, type VerbConfig } from "./config.js";
import { FORMAT_PROVIDERS } from "./format.js";
import { LINT_PROVIDERS } from "./lint.js";
import { hasBinary, resolveBinary } from "./resolveBinary.js";
import { RUN_PROVIDERS } from "./run.js";
import { TEST_PROVIDERS } from "./test.js";
import { TYPECHECK_PROVIDERS } from "./typecheck.js";
import {
  type ProviderEntry,
  type ResolvedTask,
  TASK_VERBS,
  type TaskContext,
  type TaskProvider,
  type TaskVerb,
  type VerbReport,
} from "./types.js";

const REGISTRY: Record<TaskVerb, readonly TaskProvider[]> = {
  build: BUILD_PROVIDERS,
  lint: LINT_PROVIDERS,
  typecheck: TYPECHECK_PROVIDERS,
  test: TEST_PROVIDERS,
  format: FORMAT_PROVIDERS,
  run: RUN_PROVIDERS,
};

export function providersFor(verb: TaskVerb): readonly TaskProvider[] {
  return REGISTRY[verb];
}

/** Splits a simple shell-like command string into argv tokens when there are no shell operators. */
function splitCommandTokens(cmd: string): string[] | undefined {
  if (/[|;&<>`$()]/.test(cmd)) return undefined;
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasToken = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === undefined) continue;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== undefined) return undefined;
  if (hasToken) tokens.push(current);
  return tokens;
}

function customCommandArgv(command: string, extraArgs: readonly string[]): string[] {
  const tokens = splitCommandTokens(command);
  if (tokens !== undefined && tokens.length > 0) return [...tokens, ...extraArgs];
  if (extraArgs.length === 0) return ["sh", "-c", command];
  return ["sh", "-c", `${command} "$@"`, "sh", ...extraArgs];
}

function pickProvider(
  verb: TaskVerb,
  root: string,
  cfg: VerbConfig | undefined,
  ctx?: TaskContext,
): { provider?: TaskProvider; why: string } {
  const list = REGISTRY[verb];
  if (cfg?.provider !== undefined) {
    const chosen = list.find((p) => p.id === cfg.provider);
    if (chosen === undefined) {
      const valid = list.map((p) => p.id).join(", ");
      throw new TaskConfigError(
        `${cfg.sourceKey}: unknown ${verb} provider "${cfg.provider}" (valid: ${valid})`,
      );
    }
    return { provider: chosen, why: `configured in .agentvibes/project.toml (${cfg.sourceKey})` };
  }
  const applicable = list
    .map((p) => ({
      provider: p,
      detection: p.detect(root, ctx),
      priority: p.priority?.(root, ctx) ?? 0,
    }))
    .filter((x) => x.detection.applicable)
    .sort((a, b) => b.priority - a.priority);

  const winner = applicable[0];
  if (winner === undefined) {
    return { why: `no applicable ${verb} provider detected` };
  }
  return { provider: winner.provider, why: `detected: ${winner.detection.reason}` };
}

export function resolveTask(
  verb: TaskVerb,
  root: string,
  args: readonly string[] = [],
  ctx?: TaskContext,
): ResolvedTask {
  const all = readTasksConfig(root);
  const cfg = all[verb];
  const configKey = cfg?.sourceKey ?? `[tasks.${verb}]`;

  if (cfg?.command !== undefined) {
    return {
      status: "custom",
      verb,
      command: cfg.command,
      argv: customCommandArgv(cfg.command, args),
      why: `configured in .agentvibes/project.toml (${cfg.sourceKey})`,
      configKey,
    };
  }

  const picked = pickProvider(verb, root, cfg, ctx);
  if (picked.provider === undefined) {
    return { status: "none", verb, why: picked.why, configKey };
  }
  const providerArgs = picked.provider.command(root, args, ctx);
  return {
    status: "provider",
    verb,
    provider: picked.provider,
    argv: [picked.provider.binary, ...providerArgs],
    why: picked.why,
    warning: picked.provider.warning?.(root, ctx),
    configKey,
  };
}

export function inspectProviders(root: string, ctx?: TaskContext): Record<TaskVerb, VerbReport> {
  const out = {} as Record<TaskVerb, VerbReport>;
  for (const verb of TASK_VERBS) {
    const resolved = resolveTask(verb, root, [], ctx);
    const activeId = match(resolved)
      .with({ status: "provider" }, (r) => r.provider.id)
      .with({ status: "custom" }, () => "custom")
      .with({ status: "none" }, () => null)
      .exhaustive();
    const entries: ProviderEntry[] = REGISTRY[verb].map((p) => {
      const det = p.detect(root, ctx);
      const avail = (ctx?.hasBinary ?? hasBinary)(root, p.binary);
      return {
        id: p.id,
        binary: p.binary,
        applicable: det.applicable,
        available: avail,
        active: activeId === p.id,
        reason: det.reason,
      };
    });
    const command = match(resolved)
      .with({ status: "provider" }, { status: "custom" }, (r) => r.argv)
      .with({ status: "none" }, () => null)
      .exhaustive();
    out[verb] = {
      active: activeId,
      why: resolved.why,
      command,
      configKey: `[tasks.${verb}]`,
      providers: entries,
    };
  }
  return out;
}

export function runProvidersCommand(json: boolean, root: string = process.cwd()): number {
  let report: Record<TaskVerb, VerbReport>;
  try {
    report = inspectProviders(root);
  } catch (err) {
    if (err instanceof TaskConfigError) {
      console.error(`guardrails providers: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (json) {
    console.log(JSON.stringify({ command: "providers", root, verbs: report }, null, 2));
    return 0;
  }

  for (const verb of TASK_VERBS) {
    const v = report[verb];
    console.log(`${verb.padEnd(11)} active: ${v.active ?? "none"} — ${v.why} (${v.configKey})`);
    for (const p of v.providers) {
      const mark = p.active ? "*" : " ";
      const app = p.applicable ? "applicable" : "-         ";
      const avail = p.available ? "available" : "missing  ";
      console.log(`  ${mark} ${p.id.padEnd(14)} ${app}  ${avail}  ${p.reason}`);
    }
  }
  return 0;
}

function missingBinaryMessage(
  verb: TaskVerb,
  binary: string,
  installHint: string,
  providerId: string | undefined,
): string {
  const alts = REGISTRY[verb].map((p) => p.id).join(", ");
  const who =
    providerId === undefined
      ? `command "${binary}"`
      : `provider "${providerId}" (binary "${binary}")`;
  return [
    `guardrails ${verb}: ${who} was not found in node_modules/.bin or on PATH.`,
    `  Install: ${installHint}`,
    `  Or configure another provider in .agentvibes/project.toml: [tasks.${verb}] provider = "<id>" (available: ${alts}) or command = "..."`,
  ].join("\n");
}

export async function runTask(opts: {
  verb: TaskVerb;
  args: readonly string[];
  json: boolean;
  run: RunCollector;
  root?: string;
}): Promise<number> {
  const root = opts.root ?? process.cwd();
  if (opts.verb === "run" && opts.args.length === 0) {
    console.error("guardrails run: specify a file to run (e.g. guardrails run src/script.ts)");
    return 2;
  }

  let resolved: ResolvedTask;
  try {
    resolved = resolveTask(opts.verb, root, opts.args);
  } catch (err) {
    if (err instanceof TaskConfigError) {
      console.error(`guardrails ${opts.verb}: ${err.message}`);
      return 2;
    }
    throw err;
  }

  return match(resolved)
    .with({ status: "none" }, (r) => {
      const alts = REGISTRY[opts.verb].map((p) => p.id).join(", ");
      console.error(
        `guardrails ${opts.verb}: ${r.why}. Configure [tasks.${opts.verb}] provider = "<id>" (available: ${alts}) or command = "..." in .agentvibes/project.toml`,
      );
      return 2;
    })
    .with({ status: "provider" }, { status: "custom" }, async (r) => {
      const [binary, ...argv] = r.argv;
      if (binary === undefined) {
        console.error(`guardrails ${opts.verb}: resolved command is empty`);
        return 2;
      }

      const bin = resolveBinary(root, binary);
      if (bin === undefined) {
        const hint = match(r)
          .with({ status: "provider" }, (p) => p.provider.installHint)
          .with({ status: "custom" }, () => `ensure "${binary}" is installed and on PATH`)
          .exhaustive();
        const providerId = match(r)
          .with({ status: "provider" }, (p) => p.provider.id)
          .with({ status: "custom" }, () => undefined)
          .exhaustive();
        console.error(missingBinaryMessage(opts.verb, binary, hint, providerId));
        return 2;
      }

      const warning = match(r)
        .with({ status: "provider" }, (p) => p.warning)
        .with({ status: "custom" }, () => undefined)
        .exhaustive();
      if (warning !== undefined) console.warn(warning);

      const [execFile, ...execPrefix] = bin.prefix;
      if (execFile === undefined) return 2;
      const execArgs = [...execPrefix, ...argv];

      const afterFn = match(r)
        .with({ status: "provider" }, (p) => p.provider.after)
        .with({ status: "custom" }, () => undefined)
        .exhaustive();

      return runTimedChild({
        metricName: `task:${opts.verb}`,
        label: `guardrails ${opts.verb}`,
        command: opts.verb,
        file: execFile,
        args: execArgs,
        cwd: root,
        json: opts.json,
        run: opts.run,
        ...(afterFn !== undefined ? { after: () => afterFn(root, opts.json) } : {}),
      });
    })
    .exhaustive();
}
