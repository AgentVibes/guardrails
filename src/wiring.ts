import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { match } from "ts-pattern";
import { z } from "zod";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { collectOverrides, type OverrideReport } from "./overrides.js";
import { packageRoot } from "./packagePaths.js";
import { presetDrift } from "./presetDrift.js";
import { declaredRuleDirs } from "./repoRules.js";

// Wiring: is guardrails actually running in this repo, or only installed?
// Each check reads one file and answers pass/fail with the evidence. `doctor`
// prints them and `snapshot` records them, so a dashboard can list the repos
// where a piece is missing. Wiring never changes an exit code; only preset
// drift (presetDrift.ts) gates.
//
// The overall state:
//   on      — every check passes AND the repo overrides nothing of the canon;
//   off     — guardrails is not installed and nothing else is wired either;
//   partial — anything in between, including "fully wired, but overrides".

export const PACKAGE_NAME = "@agentvibes/guardrails";

export const WIRING_CHECKS = [
  "installed",
  "sgconfig-canon",
  "lint-script",
  "ci",
  "hook-postedit",
  "hook-stop",
  "preset",
] as const;
export type WiringCheckId = (typeof WIRING_CHECKS)[number];

export interface WiringCheck {
  id: WiringCheckId;
  status: "pass" | "fail";
  /** The evidence: what was found, or what is missing and where it was looked for. */
  detail: string;
}

export type WiringState = "off" | "partial" | "on";

export type OverrideCount =
  | { status: "counted"; total: number; withoutReason: number }
  | { status: "unreadable"; error: string };

export interface WiringReport {
  state: WiringState;
  checks: WiringCheck[];
  overrides: OverrideCount;
}

const PackageJson = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  scripts: z.record(z.string(), z.string()).default({}),
});
type PackageJson = z.infer<typeof PackageJson>;

type PackageRead =
  | { status: "absent" }
  | { status: "unreadable"; error: string }
  | { status: "read"; pkg: PackageJson };

function readPackage(root: string): PackageRead {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { status: "absent" };
  try {
    const parsed = PackageJson.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success
      ? { status: "read", pkg: parsed.data }
      : { status: "unreadable", error: parsed.error.issues[0]?.message ?? "invalid" };
  } catch (err) {
    return { status: "unreadable", error: (err as Error).message.split("\n")[0] ?? "" };
  }
}

function pass(id: WiringCheckId, detail: string): WiringCheck {
  return { id, status: "pass", detail };
}
function fail(id: WiringCheckId, detail: string): WiringCheck {
  return { id, status: "fail", detail };
}

const isSelf = (root: string): boolean => resolve(root) === resolve(packageRoot);

function checkInstalled(root: string, read: PackageRead): WiringCheck {
  if (isSelf(root)) return pass("installed", "this repo is the package itself");
  return match(read)
    .with({ status: "absent" }, () => fail("installed", "no package.json at the repo root"))
    .with({ status: "unreadable" }, (r) => fail("installed", `package.json unreadable: ${r.error}`))
    .with({ status: "read" }, ({ pkg }) => {
      const version = pkg.devDependencies[PACKAGE_NAME] ?? pkg.dependencies[PACKAGE_NAME];
      return version === undefined
        ? fail("installed", `${PACKAGE_NAME} is not in the root package.json dependencies`)
        : pass("installed", `${PACKAGE_NAME} ${version}`);
    })
    .exhaustive();
}

function checkSgconfig(root: string): WiringCheck {
  if (isSelf(root)) return pass("sgconfig-canon", "this repo is the package itself");
  const path = join(root, "sgconfig.yml");
  if (!existsSync(path)) return fail("sgconfig-canon", "no sgconfig.yml at the repo root");
  const dirs = declaredRuleDirs(path);
  const canon = dirs.filter((d) => d.includes(`${PACKAGE_NAME}/rules`));
  return canon.length > 0
    ? pass("sgconfig-canon", `ruleDirs lists ${canon.join(", ")}`)
    : fail(
        "sgconfig-canon",
        `sgconfig.yml ruleDirs (${dirs.join(", ") || "none"}) do not list node_modules/${PACKAGE_NAME}/rules — editor and bare ast-grep runs miss the canon`,
      );
}

const RUNS_GUARDRAILS = /\bguardrails\s+(verify|verify-diff|doctor|metrics|leaks)\b/;
/** `pnpm x`, `pnpm run x`, `npm run x`, `yarn x` — a call to another package script. */
const SCRIPT_CALL = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g;
/** A file a script runs: `scripts/lint/x.sh`, `./tools/check.mjs`. */
const FILE_CALL = /(?:^|\s)(\.?\.?\/?[\w./-]+\.(?:sh|mjs|cjs|js|ts))\b/g;

/**
 * Where a script runs guardrails, following package-script calls and the files
 * the script runs, one level deep. undefined when it does not.
 */
function guardrailsIn(
  root: string,
  scripts: Record<string, string>,
  name: string,
): string | undefined {
  const body = scripts[name];
  if (body === undefined) return undefined;
  if (RUNS_GUARDRAILS.test(body)) return `"${name}" runs guardrails`;
  for (const [, called] of body.matchAll(SCRIPT_CALL)) {
    const inner = called === undefined ? undefined : scripts[called];
    if (inner !== undefined && RUNS_GUARDRAILS.test(inner))
      return `"${name}" → "${called}" runs guardrails`;
  }
  for (const [, file] of body.matchAll(FILE_CALL)) {
    if (file === undefined) continue;
    const path = join(root, file);
    if (existsSync(path) && RUNS_GUARDRAILS.test(readFileSync(path, "utf8"))) {
      return `"${name}" → ${file} runs guardrails`;
    }
  }
  return undefined;
}

const LINT_SCRIPTS = ["lint", "check"] as const;

function checkLint(
  root: string,
  read: PackageRead,
): { check: WiringCheck; script: string | undefined } {
  return match(read)
    .with({ status: "read" }, ({ pkg }) => {
      for (const name of LINT_SCRIPTS) {
        const where = guardrailsIn(root, pkg.scripts, name);
        if (where !== undefined) return { check: pass("lint-script", where), script: name };
      }
      return {
        check: fail(
          "lint-script",
          `neither the "lint" nor the "check" script runs guardrails (followed one level into scripts and the files they run)`,
        ),
        script: undefined,
      };
    })
    .with({ status: "absent" }, { status: "unreadable" }, () => ({
      check: fail("lint-script", "no readable package.json, so no lint script"),
      script: undefined,
    }))
    .exhaustive();
}

function ciFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of [".github/workflows", ".gitea/workflows"]) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) if (/\.ya?ml$/.test(f)) out.push(`${dir}/${f}`);
  }
  if (existsSync(join(root, ".gitlab-ci.yml"))) out.push(".gitlab-ci.yml");
  return out.sort();
}

const REUSABLE_GATE = /agentvibes\/guardrails\/\.github\/workflows\/guardrails-gate\.ya?ml/i;

function checkCi(root: string, lintScript: string | undefined): WiringCheck {
  const files = ciFiles(root);
  if (files.length === 0)
    return fail("ci", "no CI config (.github/workflows, .gitea/workflows, .gitlab-ci.yml)");
  const lintCall =
    lintScript === undefined
      ? undefined
      : new RegExp(`\\b(?:pnpm|npm|yarn|bun)\\s+(?:run\\s+)?${lintScript}\\b`);
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    if (REUSABLE_GATE.test(text)) return pass("ci", `${f} uses the reusable guardrails gate`);
    if (RUNS_GUARDRAILS.test(text)) return pass("ci", `${f} runs guardrails`);
    if (lintCall?.test(text) === true)
      return pass("ci", `${f} runs "${lintScript}", which runs guardrails`);
  }
  return fail(
    "ci",
    `none of ${files.join(", ")} runs guardrails, the reusable gate, or a lint script that does`,
  );
}

const HookEntry = z
  .object({ hooks: z.array(z.object({ command: z.string().default("") }).loose()).default([]) })
  .loose();
const ClaudeSettings = z
  .object({ hooks: z.record(z.string(), z.array(HookEntry)).default({}) })
  .loose();

function hookCommands(
  root: string,
): { status: "read"; byEvent: Map<string, string[]> } | { status: "none"; why: string } {
  const path = join(root, ".claude", "settings.json");
  if (!existsSync(path)) return { status: "none", why: "no .claude/settings.json" };
  try {
    const parsed = ClaudeSettings.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success)
      return {
        status: "none",
        why: `.claude/settings.json: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
    const byEvent = new Map<string, string[]>();
    for (const [event, entries] of Object.entries(parsed.data.hooks)) {
      byEvent.set(
        event,
        entries.flatMap((e) => e.hooks.map((h) => h.command)),
      );
    }
    return { status: "read", byEvent };
  } catch (err) {
    return {
      status: "none",
      why: `.claude/settings.json unreadable: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

function checkHook(
  id: "hook-postedit" | "hook-stop",
  event: "PostToolUse" | "Stop",
  read: ReturnType<typeof hookCommands>,
): WiringCheck {
  return match(read)
    .with({ status: "none" }, (r) => fail(id, r.why))
    .with({ status: "read" }, (r) => {
      // Any wrapper counts (`sh opt-hook.sh pnpm exec guardrails hook-stop`):
      // the command only has to end up calling the subcommand.
      const cmd = (r.byEvent.get(event) ?? []).find(
        (c) => /guardrails\b/.test(c) && c.includes(id),
      );
      return cmd === undefined
        ? fail(id, `.claude/settings.json has no ${event} hook running guardrails ${id}`)
        : pass(id, `${event}: ${cmd}`);
    })
    .exhaustive();
}

function checkPreset(root: string): WiringCheck {
  const drift = presetDrift(root);
  return drift.length === 0
    ? pass(
        "preset",
        existsSync(join(root, "biome.json")) ? "biome.json follows the preset" : "no biome config",
      )
    : fail("preset", drift.map((d) => d.detail).join("; "));
}

function countOverrides(root: string, report: OverrideReport | undefined): OverrideCount {
  try {
    const r = report ?? collectOverrides(root);
    return {
      status: "counted",
      total: r.overrides.length,
      withoutReason: r.overrides.filter((o) => o.reason.status === "missing").length,
    };
  } catch (err) {
    if (err instanceof OverrideConfigError) return { status: "unreadable", error: err.message };
    throw err;
  }
}

/** The overall state from the checks and the override count. */
export function wiringState(checks: readonly WiringCheck[], overrides: OverrideCount): WiringState {
  const passed = (id: WiringCheckId): boolean =>
    checks.some((c) => c.id === id && c.status === "pass");
  const wiredAnywhere = WIRING_CHECKS.filter((id) => id !== "preset").some(passed);
  if (!wiredAnywhere) return "off";
  const allPass = checks.every((c) => c.status === "pass");
  const noOverrides = match(overrides)
    .with({ status: "counted" }, (o) => o.total === 0)
    .with({ status: "unreadable" }, () => false)
    .exhaustive();
  return allPass && noOverrides ? "on" : "partial";
}

/**
 * Every wiring check for `root`, and the overall state. Pass the override
 * report when the caller already has one, so the tree is not scanned twice.
 */
export function detectWiring(root: string, overrideReport?: OverrideReport): WiringReport {
  const pkg = readPackage(root);
  const lint = checkLint(root, pkg);
  const hooks = hookCommands(root);
  const checks: WiringCheck[] = [
    checkInstalled(root, pkg),
    checkSgconfig(root),
    lint.check,
    checkCi(root, lint.script),
    checkHook("hook-postedit", "PostToolUse", hooks),
    checkHook("hook-stop", "Stop", hooks),
    checkPreset(root),
  ];
  const overrides = countOverrides(root, overrideReport);
  return { state: wiringState(checks, overrides), checks, overrides };
}
