import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hookCommand, isUnguardedHook, upgradedCommand } from "./claudeHooks.js";
import { packageRoot } from "./packagePaths.js";

// The agent hook commands (claudeHooks.ts), run for real through /bin/sh:
//   - without an install they exit 0 and print nothing (the red case: the old
//     `pnpm exec guardrails …` form fails there);
//   - with an install they run guardrails;
//   - `init` rewrites the old form, leaves wrapped and other commands alone,
//     adds no duplicate, and a second run changes nothing.

let failed = 0;
function check(step: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  hooks: ${step}`);
    return;
  }
  failed += 1;
  console.error(`FAIL hooks: ${step}\n${detail}`);
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function sh(command: string, cwd: string, env: Record<string, string> = {}): Ran {
  const res = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
    input: "{}",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** A stand-in guardrails binary that says it ran. */
function fakeInstall(dir: string): void {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "guardrails"), '#!/bin/sh\necho "ran $1"\n');
  chmodSync(join(bin, "guardrails"), 0o755);
}

function repo(base: string, name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, private: true })}\n`);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return dir;
}

// A PATH with node, npx and pnpm but no globally installed guardrails, so an
// install on the test machine cannot hide the "not installed" case.
const NO_GLOBAL = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

function commandRuns(base: string): void {
  for (const [lock, label] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
  ] as const) {
    const dir = repo(base, `run-${label}`, { [lock]: lock === "pnpm-lock.yaml" ? "" : "{}" });
    const cmd = hookCommand(dir, "hook-postedit");
    const bare = sh(
      `${label === "pnpm" ? "pnpm exec" : "npx --no-install"} guardrails hook-postedit`,
      dir,
      NO_GLOBAL,
    );
    check(
      `${label}: the old form fails without an install (the case this fixes)`,
      bare.status !== 0,
      JSON.stringify(bare),
    );
    const none = sh(cmd, dir, NO_GLOBAL);
    check(
      `${label}: no install → exit 0, no output`,
      none.status === 0 && none.stdout === "" && none.stderr === "",
      `${cmd}\n${JSON.stringify(none)}`,
    );
    fakeInstall(dir);
    const ran = sh(cmd, dir, NO_GLOBAL);
    check(
      `${label}: installed → runs guardrails`,
      ran.status === 0 && ran.stdout.trim() === "ran hook-postedit",
      `${cmd}\n${JSON.stringify(ran)}`,
    );
    mkdirSync(join(dir, "sub"), { recursive: true });
    const fromSub = sh(cmd, join(dir, "sub"), { ...NO_GLOBAL, CLAUDE_PROJECT_DIR: dir });
    check(
      `${label}: from a subdirectory, the check reads $CLAUDE_PROJECT_DIR`,
      fromSub.status === 0 && fromSub.stdout.trim() === "ran hook-postedit",
      JSON.stringify(fromSub),
    );
  }
  const yarn = repo(base, "run-yarn", { "yarn.lock": "" });
  const y = sh(hookCommand(yarn, "hook-stop"), yarn, NO_GLOBAL);
  check(
    "yarn: no node_modules and no Plug'n'Play install state → exit 0, no output",
    y.status === 0 && y.stdout === "" && y.stderr === "",
    JSON.stringify(y),
  );
  const global = mkdtempSync(join(base, "global-"));
  const g = sh(hookCommand(global, "hook-stop"), global, NO_GLOBAL);
  check(
    "no Node project, guardrails not on PATH → exit 0, no output",
    g.status === 0 && g.stdout === "" && g.stderr === "",
    JSON.stringify(g),
  );
}

const OLD_POST = "pnpm exec guardrails hook-postedit";
const WRAPPED_STOP = 'sh "$HOME/.claude/hooks/opt-hook.sh" pnpm exec guardrails hook-stop';

function settingsWith(post: string, stop: string): string {
  return `${JSON.stringify(
    {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: post, timeout: 99 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: stop }] }],
      },
    },
    null,
    2,
  )}\n`;
}

function init(cwd: string): Ran {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "init"], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

const Parsed = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
    permissions: unknown;
    hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
  };

function initUpgrades(base: string): void {
  for (const [label, extra] of [
    ["TypeScript repo", { "pnpm-lock.yaml": "", "tsconfig.json": "{}\n" }],
    [
      "Rust repo",
      { "pnpm-lock.yaml": "", "Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\n' },
    ],
  ] as const) {
    const dir = repo(base, `init-${label.split(" ")[0]?.toLowerCase()}`, {
      ...extra,
      ".claude/settings.json": settingsWith(OLD_POST, WRAPPED_STOP),
    });
    const first = init(dir);
    const s = Parsed(dir);
    const post = s.hooks.PostToolUse ?? [];
    const stop = s.hooks.Stop ?? [];
    check(
      `${label}: init rewrites the old PostToolUse command, keeps matcher and timeout`,
      first.status === 0 &&
        post.length === 1 &&
        post[0]?.matcher === "Edit|Write" &&
        post[0]?.hooks[0]?.timeout === 99 &&
        post[0]?.hooks[0]?.command === hookCommand(dir, "hook-postedit"),
      `${first.stdout}${first.stderr}\n${JSON.stringify(s, null, 2)}`,
    );
    check(
      `${label}: a wrapped command is left as it is, and no duplicate Stop hook is added`,
      stop.length === 1 && stop[0]?.hooks[0]?.command === WRAPPED_STOP,
      JSON.stringify(stop),
    );
    check(
      `${label}: other settings are kept`,
      JSON.stringify(s.permissions) === JSON.stringify({ allow: ["Bash(ls)"] }),
      JSON.stringify(s.permissions),
    );
    const before = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    init(dir);
    check(
      `${label}: a second init changes nothing`,
      readFileSync(join(dir, ".claude", "settings.json"), "utf8") === before,
    );
  }
  // No lockfile at the root: the upgrade keeps the old command's runner
  // instead of falling back to a guardrails on PATH (which would be a silent no-op).
  const noLock = repo(base, "init-no-lock", {
    "tsconfig.json": "{}\n",
    ".claude/settings.json": settingsWith(OLD_POST, "npx guardrails hook-stop"),
  });
  init(noLock);
  const nl = Parsed(noLock);
  const nlPost = nl.hooks.PostToolUse?.[0]?.hooks[0]?.command ?? "";
  const nlStop = nl.hooks.Stop?.[0]?.hooks[0]?.command ?? "";
  check(
    "no lockfile: the upgrade keeps pnpm exec and npx, behind the install check",
    nlPost === upgradedCommand(OLD_POST, "hook-postedit") &&
      nlPost.includes("exec pnpm exec guardrails hook-postedit") &&
      nlPost.includes("node_modules/.bin/guardrails") &&
      nlStop.includes("exec npx --no-install guardrails hook-stop") &&
      nlStop.includes("node_modules/.bin/guardrails"),
    JSON.stringify(nl.hooks, null, 2),
  );
  fakeInstall(noLock);
  const nlRan = sh(nlPost, noLock, NO_GLOBAL);
  check(
    "no lockfile: the upgraded command still runs the installed guardrails",
    nlRan.status === 0 && nlRan.stdout.trim() === "ran hook-postedit",
    JSON.stringify(nlRan),
  );

  const plain = repo(base, "init-no-settings", { "tsconfig.json": "{}\n" });
  init(plain);
  check(
    "TypeScript repo without .claude/settings.json: init adds no hooks (as before)",
    spawnSync("test", ["-e", join(plain, ".claude", "settings.json")]).status !== 0,
  );
}

function oldFormDetection(): void {
  const cases: [string, "hook-postedit" | "hook-stop", boolean][] = [
    ["pnpm exec guardrails hook-postedit", "hook-postedit", true],
    ["  npx --no-install guardrails hook-stop ", "hook-stop", true],
    ["yarn guardrails hook-stop", "hook-stop", true],
    ["pnpm exec guardrails hook-stop", "hook-postedit", false],
    [WRAPPED_STOP, "hook-stop", false],
    ["pnpm -s guardrails hook-stop", "hook-stop", false],
  ];
  for (const [cmd, sub, want] of cases)
    check(
      `old form ${want ? "is" : "is not"}: ${cmd.trim()} (${sub})`,
      isUnguardedHook(cmd, sub) === want,
    );
  const fresh = mkdtempSync(join(tmpdir(), "guardrails-hooks-new-"));
  writeFileSync(join(fresh, "pnpm-lock.yaml"), "");
  check(
    "the new form is not the old form",
    !isUnguardedHook(hookCommand(fresh, "hook-stop"), "hook-stop"),
  );
  rmSync(fresh, { recursive: true, force: true });
}

function main(): number {
  const base = mkdtempSync(join(tmpdir(), "guardrails-hooks-"));
  try {
    oldFormDetection();
    commandRuns(base);
    initUpgrades(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  if (failed > 0) return 1;
  console.log("hook command fixtures passed");
  return 0;
}

process.exit(main());
