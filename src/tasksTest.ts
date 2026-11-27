import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { match } from "ts-pattern";
import { packageRoot } from "./packagePaths.js";
import { TaskConfigError } from "./tasks/config.js";
import { inspectProviders, resolveTask } from "./tasks/registry.js";
import { TASK_VERBS, type TaskContext, type TaskVerb } from "./tasks/types.js";

const CLI = join(packageRoot, "dist", "cli.js");
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `\n  ${detail}`}`);
}

function makeFixture(tree: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-tasks-"));
  for (const [relPath, content] of Object.entries(tree)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function resolvedProvider(
  verb: TaskVerb,
  root: string,
  args: readonly string[] = [],
  ctx?: TaskContext,
): { id: string; argv: string[]; warning?: string | undefined } {
  const r = resolveTask(verb, root, args, ctx);
  return match(r)
    .with({ status: "provider" }, (p) => ({
      id: p.provider.id,
      argv: p.argv,
      warning: p.warning,
    }))
    .with({ status: "custom" }, (c) => ({ id: "custom", argv: c.argv }))
    .with({ status: "none" }, () => ({ id: "none", argv: [] }))
    .exhaustive();
}

function writeBinStub(root: string, name: string, scriptBody: string): void {
  const binPath = join(root, "node_modules", ".bin", name);
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(binPath, `#!/usr/bin/env node\n${scriptBody}`);
  chmodSync(binPath, 0o755);
}

function rows(db: string, sql: string): Record<string, unknown>[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    d.close();
  }
}

function detectionCases(): void {
  // lint
  const tsLint = makeFixture({ "package.json": '{"name":"example-app"}' });
  const oxLint = makeFixture({
    "package.json": '{"name":"example-app"}',
    ".oxlintrc.json": "{}",
  });
  const bothLint = makeFixture({
    "package.json": '{"name":"example-app"}',
    "biome.json": "{}",
    ".oxlintrc.json": "{}",
  });
  try {
    check(
      "lint defaults to biome for TS",
      JSON.stringify(resolvedProvider("lint", tsLint)) ===
        JSON.stringify({ id: "biome", argv: ["biome", "check", "."] }),
    );
    check(
      "lint detects oxlint when .oxlintrc.json without biome.json",
      resolvedProvider("lint", oxLint).id === "oxlint",
    );
    check(
      "lint prefers biome when biome.json is also present",
      resolvedProvider("lint", bothLint).id === "biome",
    );
  } finally {
    rmSync(tsLint, { recursive: true, force: true });
    rmSync(oxLint, { recursive: true, force: true });
    rmSync(bothLint, { recursive: true, force: true });
  }

  // format
  const tsFmt = makeFixture({ "package.json": '{"name":"example-app"}' });
  const dprintFmt = makeFixture({
    "package.json": '{"name":"example-app"}',
    "dprint.json": "{}",
  });
  try {
    check(
      "format defaults to biome format --write",
      JSON.stringify(resolvedProvider("format", tsFmt)) ===
        JSON.stringify({ id: "biome", argv: ["biome", "format", "--write", "."] }),
    );
    check(
      "format detects dprint when dprint.json without biome.json",
      JSON.stringify(resolvedProvider("format", dprintFmt)) ===
        JSON.stringify({ id: "dprint", argv: ["dprint", "fmt"] }),
    );
  } finally {
    rmSync(tsFmt, { recursive: true, force: true });
    rmSync(dprintFmt, { recursive: true, force: true });
  }

  // typecheck
  const ts7 = makeFixture({
    "package.json": '{"name":"example-app","devDependencies":{"typescript":"^7.0.2"}}',
    "tsconfig.json": "{}",
  });
  const tsgoDir = makeFixture({
    "package.json":
      '{"name":"example-app","devDependencies":{"typescript":"^5.7.3","@typescript/native-preview":"^7.0.0-dev"}}',
    "tsconfig.json": "{}",
  });
  const ts5 = makeFixture({
    "package.json": '{"name":"example-app","devDependencies":{"typescript":"^5.7.3"}}',
    "tsconfig.json": "{}",
  });
  const rustOnly = makeFixture({
    "Cargo.toml": '[package]\nname = "example-crate"\nversion = "0.1.0"\n',
  });
  try {
    const r7 = resolvedProvider("typecheck", ts7);
    check(
      "typecheck typescript >= 7 uses tsc --noEmit with no warning",
      r7.id === "tsc" &&
        r7.warning === undefined &&
        JSON.stringify(r7.argv) === JSON.stringify(["tsc", "--noEmit", "-p", "tsconfig.json"]),
      JSON.stringify(r7),
    );
    const rTsgo = resolvedProvider("typecheck", tsgoDir);
    check(
      "typecheck @typescript/native-preview uses tsgo --noEmit",
      rTsgo.id === "tsgo" &&
        rTsgo.warning === undefined &&
        JSON.stringify(rTsgo.argv) === JSON.stringify(["tsgo", "--noEmit", "-p", "tsconfig.json"]),
      JSON.stringify(rTsgo),
    );
    const r5 = resolvedProvider("typecheck", ts5);
    check(
      "typecheck typescript < 7 runs tsc with upgrade warning",
      r5.id === "tsc" &&
        typeof r5.warning === "string" &&
        r5.warning.includes("typescript >= 7"),
      JSON.stringify(r5),
    );
    const rFlag = resolvedProvider("typecheck", ts7, ["-p", "tsconfig.build.json"]);
    check(
      "typecheck respects -p tsconfig path arg",
      JSON.stringify(rFlag.argv) ===
        JSON.stringify(["tsc", "--noEmit", "-p", "tsconfig.build.json"]),
      JSON.stringify(rFlag),
    );
    const rBareJson = resolvedProvider("typecheck", ts7, ["tsconfig.build.json"]);
    check(
      "typecheck respects bare tsconfig path arg",
      JSON.stringify(rBareJson.argv) ===
        JSON.stringify(["tsc", "--noEmit", "-p", "tsconfig.build.json"]),
      JSON.stringify(rBareJson),
    );
    const rRust = resolvedProvider("typecheck", rustOnly);
    check(
      "typecheck Rust crate picks cargo check",
      rRust.id === "cargo" && JSON.stringify(rRust.argv) === JSON.stringify(["cargo", "check"]),
      JSON.stringify(rRust),
    );
  } finally {
    rmSync(ts7, { recursive: true, force: true });
    rmSync(tsgoDir, { recursive: true, force: true });
    rmSync(ts5, { recursive: true, force: true });
    rmSync(rustOnly, { recursive: true, force: true });
  }

  // build
  const nextApp = makeFixture({
    "package.json": '{"name":"example-next","dependencies":{"next":"15.0.0"}}',
  });
  const viteApp = makeFixture({
    "package.json": '{"name":"example-vite","devDependencies":{"vite":"6.0.0"}}',
  });
  const libPkg = makeFixture({
    "package.json": '{"name":"example-lib","exports":{".":"./dist/index.js"}}',
  });
  try {
    check(
      "build next detects next build --turbopack",
      JSON.stringify(resolvedProvider("build", nextApp)) ===
        JSON.stringify({ id: "next", argv: ["next", "build", "--turbopack"] }),
    );
    check(
      "build vite detects vite build",
      JSON.stringify(resolvedProvider("build", viteApp)) ===
        JSON.stringify({ id: "vite", argv: ["vite", "build"] }),
    );
    check(
      "build library with exports detects tsdown",
      JSON.stringify(resolvedProvider("build", libPkg)) ===
        JSON.stringify({ id: "tsdown", argv: ["tsdown"] }),
    );
  } finally {
    rmSync(nextApp, { recursive: true, force: true });
    rmSync(viteApp, { recursive: true, force: true });
    rmSync(libPkg, { recursive: true, force: true });
  }

  // test
  const vitestDir = makeFixture({
    "package.json": '{"name":"example-app","devDependencies":{"vitest":"3.0.0"}}',
  });
  const bunDir = makeFixture({
    "package.json": '{"name":"example-app"}',
    "bun.lock": "",
  });
  const nodeDir = makeFixture({ "package.json": '{"name":"example-app"}' });
  const rustDir = makeFixture({
    "Cargo.toml": '[package]\nname = "example-crate"\nversion = "0.1.0"\n',
  });
  try {
    check(
      "test detects vitest first",
      JSON.stringify(resolvedProvider("test", vitestDir)) ===
        JSON.stringify({ id: "vitest", argv: ["vitest", "run"] }),
    );
    check(
      "test detects bun test when bun.lock present",
      JSON.stringify(resolvedProvider("test", bunDir)) ===
        JSON.stringify({ id: "bun", argv: ["bun", "test"] }),
    );
    check(
      "test falls back to node --test when neither vitest nor bun present",
      JSON.stringify(
        resolvedProvider("test", nodeDir, [], { hasBinary: (_r, b) => b === "node" }),
      ) === JSON.stringify({ id: "node", argv: ["node", "--test"] }),
    );
    check(
      "test detects cargo nextest when available",
      JSON.stringify(
        resolvedProvider("test", rustDir, [], {
          hasBinary: (_r, b) => b === "cargo" || b === "cargo-nextest",
        }),
      ) === JSON.stringify({ id: "cargo-nextest", argv: ["cargo-nextest", "nextest", "run"] }),
    );
    check(
      "test falls back to cargo test when nextest absent",
      JSON.stringify(
        resolvedProvider("test", rustDir, [], { hasBinary: (_r, b) => b === "cargo" }),
      ) === JSON.stringify({ id: "cargo-test", argv: ["cargo", "test"] }),
    );
  } finally {
    rmSync(vitestDir, { recursive: true, force: true });
    rmSync(bunDir, { recursive: true, force: true });
    rmSync(nodeDir, { recursive: true, force: true });
    rmSync(rustDir, { recursive: true, force: true });
  }

  // run
  const runDir = makeFixture({ "package.json": '{"name":"example-app"}' });
  try {
    check(
      "run picks node on >= 22.18 / 23.6",
      resolvedProvider("run", runDir, ["src/a.ts"], { nodeVersion: "v22.18.0" }).id === "node" &&
        resolvedProvider("run", runDir, ["src/a.ts"], { nodeVersion: "v23.6.0" }).id === "node",
    );
    check(
      "run falls back to bun on older node",
      resolvedProvider("run", runDir, ["src/a.ts"], { nodeVersion: "v22.13.0" }).id === "bun" &&
        resolvedProvider("run", runDir, ["src/a.ts"], { nodeVersion: "v23.5.0" }).id === "bun",
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

function configAndCliCases(): void {
  const cfgDir = makeFixture({
    "package.json": '{"name":"example-app","dependencies":{"next":"15.0.0"}}',
    "biome.json": "{}",
    ".agentvibes/project.toml": [
      "[build]",
      'command = "echo from-build-section"',
      "",
      "[tasks.lint]",
      'provider = "oxlint"',
      "",
      "[tasks.format]",
      'provider = "dprint"',
      "",
    ].join("\n"),
  });
  const badCfgDir = makeFixture({
    "package.json": '{"name":"example-app"}',
    ".agentvibes/project.toml": '[tasks.lint]\nprovider = "nonexistent"\n',
  });
  try {
    check(
      "[build] command wins over detected next provider",
      JSON.stringify(resolvedProvider("build", cfgDir, ["--extra"])) ===
        JSON.stringify({ id: "custom", argv: ["echo", "from-build-section", "--extra"] }),
    );
    check(
      "[tasks.lint] provider override wins over biome.json",
      resolvedProvider("lint", cfgDir).id === "oxlint",
    );
    check(
      "[tasks.format] provider override wins over biome.json",
      resolvedProvider("format", cfgDir).id === "dprint",
    );

    let threw = false;
    try {
      resolveTask("lint", badCfgDir);
    } catch (err) {
      threw = err instanceof TaskConfigError;
    }
    check("unknown configured provider throws TaskConfigError", threw);

    // providers --json shape
    const provRes = spawnSync("node", [CLI, "providers", "--json"], {
      cwd: cfgDir,
      encoding: "utf8",
    });
    let shapeOk = provRes.status === 0;
    if (shapeOk) {
      const parsed = JSON.parse(provRes.stdout) as {
        command: string;
        verbs: Record<
          string,
          { active: string | null; why: string; command: string[] | null; providers: unknown[] }
        >;
      };
      shapeOk =
        parsed.command === "providers" &&
        TASK_VERBS.every(
          (v) =>
            parsed.verbs[v] !== undefined &&
            typeof parsed.verbs[v].why === "string" &&
            Array.isArray(parsed.verbs[v].providers) &&
            parsed.verbs[v].providers.length > 0,
        ) &&
        parsed.verbs.lint?.active === "oxlint" &&
        parsed.verbs.build?.active === "custom";
    }
    check("providers --json has expected shape and config state", shapeOk, provRes.stdout);

    // inspectProviders consistency
    const report = inspectProviders(cfgDir);
    check(
      "inspectProviders marks active provider",
      report.format.providers.some((p) => p.id === "dprint" && p.active),
    );
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(badCfgDir, { recursive: true, force: true });
  }

  // Missing binary error text
  const missingDir = makeFixture({
    "package.json": '{"name":"example-app","devDependencies":{"vite":"6.0.0"}}',
  });
  try {
    const res = spawnSync(process.execPath, [CLI, "build"], {
      cwd: missingDir,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    check(
      "missing binary fails loudly with install hint and config key",
      res.status === 2 &&
        res.stderr.includes("vite") &&
        res.stderr.includes("Install:") &&
        res.stderr.includes("[tasks.build]"),
      `status=${res.status}\n${res.stderr}`,
    );
  } finally {
    rmSync(missingDir, { recursive: true, force: true });
  }

  // Argv pass-through + task:<verb> recording
  const passDir = makeFixture({
    "package.json": '{"name":"example-app","devDependencies":{"vite":"6.0.0"}}',
    "script.ts": "const x: string = process.argv.slice(2).join(','); console.log(x);\n",
  });
  const db = join(passDir, "state", "g.sqlite");
  try {
    writeBinStub(passDir, "vite", "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const res = spawnSync("node", [CLI, "build", "--", "--mode", "staging"], {
      cwd: passDir,
      encoding: "utf8",
      env: { ...process.env, GUARDRAILS_RECORD: db },
    });
    const recordedRows = rows(
      db,
      "SELECT metric, value FROM metric_history WHERE metric = 'task:build'",
    );
    check(
      "build passes args after -- and records task:build",
      res.status === 0 &&
        res.stdout.trim() === '["build","--mode","staging"]' &&
        recordedRows.length === 1 &&
        typeof recordedRows[0]?.value === "number",
      `status=${res.status} stdout=${res.stdout} stderr=${res.stderr}`,
    );

    const runRes = spawnSync("node", [CLI, "run", "script.ts", "--flag", "42"], {
      cwd: passDir,
      encoding: "utf8",
      env: { ...process.env, GUARDRAILS_RECORD: db },
    });
    const runRows = rows(db, "SELECT metric FROM metric_history WHERE metric = 'task:run'");
    check(
      "run executes .ts file with args and records task:run",
      runRes.status === 0 && runRes.stdout.trim() === "--flag,42" && runRows.length === 1,
      `status=${runRes.status} stdout=${runRes.stdout} stderr=${runRes.stderr}`,
    );
  } finally {
    rmSync(passDir, { recursive: true, force: true });
  }
}

function main(): number {
  detectionCases();
  configAndCliCases();
  if (failed > 0) {
    console.error(`\n${failed} tasks check(s) failed`);
    return 1;
  }
  console.log("\ntasks passed");
  return 0;
}

process.exitCode = main();
