import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { detectWiring, type WiringCheckId, type WiringState } from "./wiring.js";

// Wiring detector (wiring.ts). Each case is a small repo tree; the test checks
// the overall state, which checks fail, and that `doctor --json` carries the
// same report with an exit code wiring never changes. The red cases: a repo
// with an override, or with one hook missing, must NOT be reported "on".

const PKG = (scripts: Record<string, string>): string =>
  `${JSON.stringify({ name: "x", devDependencies: { "@agentvibes/guardrails": "^0.2.8" }, scripts }, null, 2)}\n`;
const SG = "ruleDirs:\n  - node_modules/@agentvibes/guardrails/rules\n";
const HOOKS = (post: string, stop: string): string =>
  `${JSON.stringify(
    {
      hooks: {
        PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: post }] }],
        Stop: [{ hooks: [{ type: "command", command: stop }] }],
      },
    },
    null,
    2,
  )}\n`;
const BIOME = `${JSON.stringify({ extends: ["@agentvibes/guardrails/biome"] })}\n`;

const WIRED: Record<string, string> = {
  "package.json": PKG({ lint: "biome check . && guardrails verify ." }),
  "sgconfig.yml": SG,
  ".github/workflows/ci.yml":
    "jobs:\n  g:\n    uses: AgentVibes/guardrails/.github/workflows/guardrails-gate.yml@v0\n",
  ".claude/settings.json": HOOKS(
    "pnpm exec guardrails hook-postedit",
    "pnpm exec guardrails hook-stop",
  ),
  "biome.json": BIOME,
  "src/a.ts": "export const a = 1;\n",
};

const SELF_RULES: Record<string, string> = {
  ...WIRED,
  "package.json": `${JSON.stringify({ name: "@agentvibes/guardrails", scripts: { lint: "guardrails verify-diff" } })}\n`,
  // The canon's own rule dir and a rule fixture whose suppression is the point
  // of the fixture: neither is a repo rule shadowing the canon or an override.
  "sgconfig.yml": "ruleDirs:\n  - rules\n",
  "rules/catch-empty.yml": "id: catch-empty\nlanguage: typescript\nrule:\n  pattern: x\n",
  "rules/__fixtures__/catch-empty/good.ts":
    "// ast-grep-ignore: catch-empty -- fixture for the suppression\nexport const g = 1;\n",
};
// The package's own root biome.json extends the preset source by path.
const SELF: Record<string, string> = {
  ...SELF_RULES,
  "biome.json": `${JSON.stringify({ extends: ["./configs/biome.json"] })}\n`,
  "configs/biome.json": readFileSync(join(packageRoot, "configs", "biome.json"), "utf8"),
};

interface Case {
  name: string;
  tree: Record<string, string>;
  state: WiringState;
  failing: WiringCheckId[];
}

const CASES: Case[] = [
  {
    name: "an empty repo is off",
    tree: { "a.ts": "export const a = 1;\n" },
    state: "off",
    failing: ["installed", "sgconfig-canon", "lint-script", "ci", "hook-postedit", "hook-stop"],
  },
  { name: "everything wired and no override is on", tree: WIRED, state: "on", failing: [] },
  {
    name: "wired but one reasoned suppression is partial",
    tree: {
      ...WIRED,
      "src/a.ts": "// ast-grep-ignore: catch-empty -- cleanup may fail\nexport const a = 1;\n",
    },
    state: "partial",
    failing: [],
  },
  {
    name: "a missing Stop hook is partial",
    tree: {
      ...WIRED,
      ".claude/settings.json": HOOKS("pnpm exec guardrails hook-postedit", "echo done"),
    },
    state: "partial",
    failing: ["hook-stop"],
  },
  {
    name: "hooks behind a wrapper, lint through a script file, CI through pnpm lint",
    tree: {
      ...WIRED,
      "package.json": PKG({ lint: "pnpm lint:logic", "lint:logic": "bash scripts/lint/gate.sh" }),
      "scripts/lint/gate.sh": "#!/bin/sh\nexec guardrails verify-diff\n",
      ".github/workflows/ci.yml": "jobs:\n  c:\n    steps:\n      - run: pnpm lint\n",
      ".claude/settings.json": HOOKS(
        'sh "$HOME/.claude/hooks/opt-hook.sh" pnpm exec guardrails hook-postedit',
        'sh "$HOME/.claude/hooks/opt-hook.sh" pnpm exec guardrails hook-stop',
      ),
    },
    state: "partial",
    // `lint` → `lint:logic` → gate.sh is two levels; the detector follows one.
    failing: ["lint-script", "ci"],
  },
  {
    name: "lint one level into a script file, CI through pnpm run lint",
    tree: {
      ...WIRED,
      "package.json": PKG({ lint: "bash scripts/lint/gate.sh" }),
      "scripts/lint/gate.sh": "#!/bin/sh\nexec pnpm exec guardrails verify-diff\n",
      ".gitlab-ci.yml": "lint:\n  script:\n    - pnpm run lint\n",
      ".github/workflows/ci.yml": "jobs: {}\n",
    },
    state: "on",
    failing: [],
  },
  {
    name: "sgconfig without the canon dir is partial",
    tree: { ...WIRED, "sgconfig.yml": "ruleDirs:\n  - rules\n" },
    state: "partial",
    failing: ["sgconfig-canon"],
  },
  {
    // A checkout of this package scanned by a SEPARATE install (an installed copy
    // run against another clone): recognised by its package name, not by path.
    name: "a separate checkout of this package itself is on",
    tree: SELF,
    state: "on",
    failing: [],
  },
  {
    name: "the same tree under another package name is not exempt",
    tree: {
      ...SELF_RULES,
      "package.json": `${JSON.stringify({ name: "not-guardrails", scripts: { lint: "guardrails verify-diff" } })}\n`,
    },
    state: "partial",
    failing: ["installed", "sgconfig-canon"],
  },
];

function materialise(tree: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-wiring-"));
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function main(): number {
  let failed = 0;
  for (const c of CASES) {
    const dir = materialise(c.tree);
    try {
      const w = detectWiring(dir);
      const failing = w.checks.filter((x) => x.status === "fail").map((x) => x.id);
      const ok = w.state === c.state && JSON.stringify(failing) === JSON.stringify(c.failing);
      const doctor = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "doctor", "--json"], {
        cwd: dir,
        encoding: "utf8",
      });
      const fromDoctor = (JSON.parse(doctor.stdout) as { wiring: { state: string } }).wiring.state;
      // doctor's exit code is the tools + drift verdict only; none of these trees drift.
      const exitOk = doctor.status === 0;
      if (!ok || fromDoctor !== c.state || !exitOk) {
        failed += 1;
        console.error(
          `FAIL wiring: ${c.name}\n  state ${w.state} (doctor ${fromDoctor}, exit ${doctor.status}), want ${c.state}\n  failing ${JSON.stringify(failing)}, want ${JSON.stringify(c.failing)}\n${JSON.stringify(w.checks, null, 2)}`,
        );
        continue;
      }
      console.log(`  ok  wiring: ${c.name} → ${c.state}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (failed > 0) return 1;
  console.log("\nwiring detector passed");
  return 0;
}

process.exit(main());
