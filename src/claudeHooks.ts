import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import { z } from "zod";

// The Claude Code hooks guardrails writes into `.claude/settings.json`.
//
// A hook runs on every edit and every stop, also in a checkout where nobody
// ran the package manager's install yet (a fresh worktree). A bare
// `pnpm exec guardrails hook-postedit` fails there with "command not found",
// and the agent sees that error after every edit. So each command first
// checks that the package's binary is installed, and exits 0 silently when it
// is not. The check uses `$CLAUDE_PROJECT_DIR` (set by Claude Code), else the
// current directory, so it is right from a subdirectory too.

export type HookSub = "hook-postedit" | "hook-stop";

// The shell expands CLAUDE_PROJECT_DIR, not JavaScript: the dollar sign is escaped.
const BIN = `"\${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/guardrails"`;

function guarded(test: string, run: string): string {
  return `sh -c '${test} || exit 0; exec ${run}'`;
}

type Runner = "pnpm" | "yarn" | "npm" | "global";

function runnerCommand(runner: Runner, sub: HookSub): string {
  return (
    match(runner)
      .with("pnpm", () => guarded(`[ -x ${BIN} ]`, `pnpm exec guardrails ${sub}`))
      // Yarn Plug'n'Play has no node_modules; `yarn install` writes its install state.
      .with("yarn", () =>
        guarded(
          `{ [ -x ${BIN} ] || [ -f "\${CLAUDE_PROJECT_DIR:-.}/.yarn/install-state.gz" ]; }`,
          `yarn guardrails ${sub}`,
        ),
      )
      .with("npm", () => guarded(`[ -x ${BIN} ]`, `npx --no-install guardrails ${sub}`))
      // No Node project: guardrails is installed globally. A machine without it
      // must not fail the edit, so the hook is a no-op there.
      .with("global", () => guarded("command -v guardrails >/dev/null 2>&1", `guardrails ${sub}`))
      .exhaustive()
  );
}

function lockfileRunner(root: string): Runner {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return "global";
}

/** How a new hook calls guardrails: through the repo's package manager, or from PATH when there is none. */
export function hookCommand(root: string, sub: HookSub): string {
  return runnerCommand(lockfileRunner(root), sub);
}

/**
 * The form `init` wrote before 0.4.1 and the README showed: the package
 * manager called directly, with no check that guardrails is installed. A
 * command behind a wrapper (`sh opt-hook.sh pnpm exec …`) is not this form.
 */
const UNGUARDED = /^(pnpm exec|yarn|npx --no-install|npx) guardrails (hook-postedit|hook-stop)$/;

const RUNNER_OF: Record<string, Runner> = {
  "pnpm exec": "pnpm",
  yarn: "yarn",
  "npx --no-install": "npm",
  npx: "npm",
};

export function isUnguardedHook(command: string, sub: HookSub): boolean {
  return UNGUARDED.exec(command.trim())?.[2] === sub;
}

/**
 * The guarded form of an old command. It keeps the runner the old command
 * used, so a repo whose lockfile is not at the root (or is not committed)
 * still runs guardrails the same way, now behind the install check.
 */
export function upgradedCommand(command: string, sub: HookSub): string {
  const runner = RUNNER_OF[UNGUARDED.exec(command.trim())?.[1] ?? ""];
  if (runner === undefined) throw new Error(`not an old guardrails hook command: ${command}`);
  return runnerCommand(runner, sub);
}

/** The doctor note for a hook in the unguarded form. */
export function upgradeHint(): string {
  return 'upgrade: this command errors in a checkout without node_modules; run guardrails init to add the install check (README "Agent hooks")';
}

export interface HookAction {
  file: string;
  action: "created" | "appended" | "upgraded" | "skipped-exists" | "skipped-unreadable";
  detail?: string;
}

const HookCommandEntry = z.object({ type: z.string(), command: z.string() }).loose();
const HookEntry = z.object({ hooks: z.array(HookCommandEntry).default([]) }).loose();
const Settings = z.object({ hooks: z.record(z.string(), z.array(HookEntry)).default({}) }).loose();

const HOOKS = [
  { event: "PostToolUse", sub: "hook-postedit", matcher: "Edit|Write|MultiEdit", timeout: 120 },
  { event: "Stop", sub: "hook-stop", matcher: undefined, timeout: 360 },
] as const;

const FILE = ".claude/settings.json";

type SettingsRead =
  | { status: "read"; settings: z.infer<typeof Settings>; existed: boolean }
  | { status: "unreadable"; detail: string };

function readSettings(path: string): SettingsRead {
  let raw: unknown = {};
  const existed = existsSync(path);
  if (existed) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      return {
        status: "unreadable",
        detail: (err as Error).message.split("\n")[0] ?? "invalid JSON",
      };
    }
  }
  const parsed = Settings.safeParse(raw);
  return parsed.success
    ? { status: "read", settings: parsed.data, existed }
    : { status: "unreadable", detail: parsed.error.issues[0]?.message ?? "invalid" };
}

/**
 * Writes or upgrades the guardrails hooks in `.claude/settings.json`.
 *   - `add`: add a missing PostToolUse or Stop hook (Rust repos; init adds them);
 *   - always: rewrite a hook in the unguarded form to the guarded one.
 * Any other command, wrapped or not, is left as it is.
 */
export function writeClaudeHooks(root: string, mode: "add" | "upgrade-only"): HookAction {
  const path = join(root, ".claude", "settings.json");
  if (mode === "upgrade-only" && !existsSync(path))
    return { file: FILE, action: "skipped-exists", detail: "no .claude/settings.json" };
  return match(readSettings(path))
    .with(
      { status: "unreadable" },
      (r): HookAction => ({
        file: FILE,
        action: "skipped-unreadable",
        detail: r.detail,
      }),
    )
    .with({ status: "read" }, (r) => applyHooks(root, path, mode, r.settings, r.existed))
    .exhaustive();
}

function applyHooks(
  root: string,
  path: string,
  mode: "add" | "upgrade-only",
  settings: z.infer<typeof Settings>,
  existed: boolean,
): HookAction {
  const added: string[] = [];
  const upgraded: string[] = [];
  for (const h of HOOKS) {
    const entries = settings.hooks[h.event] ?? [];
    let present = false;
    for (const e of entries) {
      for (const c of e.hooks) {
        if (!(/guardrails\b/.test(c.command) && c.command.includes(h.sub))) continue;
        present = true;
        if (isUnguardedHook(c.command, h.sub)) {
          c.command = upgradedCommand(c.command, h.sub);
          upgraded.push(h.sub);
        }
      }
    }
    if (present || mode === "upgrade-only") continue;
    entries.push({
      ...(h.matcher === undefined ? {} : { matcher: h.matcher }),
      hooks: [{ type: "command", command: hookCommand(root, h.sub), timeout: h.timeout }],
    });
    settings.hooks[h.event] = entries;
    added.push(h.event);
  }
  if (added.length === 0 && upgraded.length === 0)
    return {
      file: FILE,
      action: "skipped-exists",
      detail:
        mode === "add" ? "both guardrails hooks are set" : "no guardrails hook in the old form",
    };
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  const details = [
    ...(added.length > 0 ? [`${added.join(" + ")} hook(s)`] : []),
    ...(upgraded.length > 0
      ? [`${upgraded.join(" + ")} now exit 0 when guardrails is not installed`]
      : []),
  ];
  return {
    file: FILE,
    action: added.length > 0 ? (existed ? "appended" : "created") : "upgraded",
    detail: details.join("; "),
  };
}
