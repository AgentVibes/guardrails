import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Fixture tests for `guardrails init` stack detection. Three mini-repos:
//   1. single-package app — the original root-only path still works
//   2. pnpm monorepo, one signal app — signals aggregate from the workspace
//      (the observatory case: root package.json is dependency-empty)
//   3. pnpm monorepo, two apps that DISAGREE — the aggregate takes the first
//      app's value and per-app [stack.app] blocks are materialized

function init(cwd: string): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "init"], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function pkg(dir: string, name: string, deps: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies: deps }));
}

function expectToml(step: string, dir: string, wants: string[], rejects: string[]): boolean {
  const toml = readFileSync(join(dir, ".agentvibes", "project.toml"), "utf8");
  for (const w of wants) {
    if (!toml.includes(w)) {
      console.error(`FAIL init: ${step} — materialized TOML lacks '${w}'\n${toml}`);
      return false;
    }
  }
  for (const r of rejects) {
    if (toml.includes(r)) {
      console.error(`FAIL init: ${step} — materialized TOML unexpectedly contains '${r}'\n${toml}`);
      return false;
    }
  }
  console.log(`  ok  init: ${step}`);
  return true;
}

function main(): number {
  const base = mkdtempSync(join(tmpdir(), "guardrails-init-test-"));
  try {
    // 1. single-package app
    const single = join(base, "single");
    pkg(single, "single-app", { mobx: "^6", vite: "^6" });
    if (init(single).status !== 0) return 1;
    if (
      !expectToml(
        "single-package app detects from root",
        single,
        ['platform = "vite-spa"', 'state = "mobx"', 'storeRuntime = "client-singleton"'],
        ["[stack.app"],
      )
    ) {
      return 1;
    }

    // 2. monorepo, dependency-empty root, one signal app among libraries
    const mono = join(base, "mono");
    pkg(mono, "mono-root", {});
    writeFileSync(join(mono, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    pkg(join(mono, "packages", "web-ui"), "@mono/web-ui", { mobx: "^6", vite: "^6" });
    pkg(join(mono, "packages", "lib"), "@mono/lib", { "ts-pattern": "^5" });
    if (init(mono).status !== 0) return 1;
    if (
      !expectToml(
        "monorepo aggregates workspace signals",
        mono,
        ['state = "mobx"', 'platform = "vite-spa"', "detected from: @mono/web-ui"],
        ["[stack.app", "@mono/lib"],
      )
    ) {
      return 1;
    }

    // 3. monorepo with two disagreeing apps
    const dual = join(base, "dual");
    pkg(dual, "dual-root", {});
    writeFileSync(join(dual, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
    pkg(join(dual, "apps", "mobile"), "@dual/mobile", { expo: "^52", nativewind: "^4" });
    pkg(join(dual, "apps", "web"), "@dual/web", { vite: "^6", mobx: "^6" });
    if (init(dual).status !== 0) return 1;
    if (
      !expectToml(
        "disagreeing apps materialize per-app blocks",
        dual,
        [
          "apps disagree on: platform, styling",
          '[stack.app."@dual/mobile"]',
          '[stack.app."@dual/web"]',
          'state = "mobx"',
        ],
        [],
      )
    ) {
      return 1;
    }

    console.log("init stack-detection fixtures passed");
    return 0;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

process.exit(main());
