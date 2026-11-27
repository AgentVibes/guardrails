import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { scanToolchain, ToolchainConfigError } from "./toolchain.js";

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
  const dir = mkdtempSync(join(tmpdir(), "guardrails-toolchain-"));
  for (const [relPath, content] of Object.entries(tree)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const WIRED_BASE: Record<string, string> = {
  "sgconfig.yml": "ruleDirs:\n  - node_modules/@agentvibes/guardrails/rules\n",
  "biome.json": '{"extends":["@agentvibes/guardrails/biome"]}\n',
  ".github/workflows/ci.yml":
    "jobs:\n  g:\n    uses: AgentVibes/guardrails/.github/workflows/guardrails-gate.yml@v0\n",
  ".claude/settings.json": JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [{ type: "command", command: "pnpm exec guardrails hook-postedit" }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "pnpm exec guardrails hook-stop" }] }],
    },
  }),
};

function findingKindsCases(): void {
  const bypassDir = makeFixture({
    "package.json": JSON.stringify({
      name: "example-app",
      scripts: {
        build: "vite build",
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        format: "prettier --write .",
      },
      devDependencies: {
        eslint: "^9.0.0",
        "@typescript-eslint/parser": "^8.0.0",
        prettier: "^3.0.0",
        webpack: "^5.0.0",
        "@babel/core": "^7.0.0",
        "babel-loader": "^9.0.0",
        "babel-jest": "^29.0.0",
        terser: "^5.0.0",
        "ts-node": "^10.0.0",
        jest: "^29.0.0",
      },
    }),
    "apps/web/package.json": JSON.stringify({
      name: "@example/web",
      scripts: { test: "jest" },
      devDependencies: { jest: "^29.0.0" },
    }),
    "node_modules/some-dep/package.json": JSON.stringify({
      name: "some-dep",
      scripts: { test: "jest" },
      devDependencies: { webpack: "^5.0.0", terser: "^5.0.0" },
    }),
    ".github/workflows/ci.yml": [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npx eslint .",
      "      - run: |",
      "          pnpm exec prettier --check .",
      "          ts-node scripts/seed.ts",
    ].join("\n"),
  });

  try {
    const rep = scanToolchain(bypassDir);
    const tools = new Set(rep.findings.map((f) => f.tool));
    check("defaults to severity warning with no config", rep.severity === "warning");
    for (const expected of [
      "script:build",
      "script:lint",
      "script:typecheck",
      "script:test",
      "script:format",
      "eslint",
      "prettier",
      "webpack",
      "babel",
      "terser",
      "ts-node",
      "jest",
    ]) {
      check(`flags ${expected}`, tools.has(expected), [...tools].join(", "));
    }
    check(
      "scans workspace package.json",
      rep.findings.some((f) => f.file === "apps/web/package.json" && f.tool === "jest"),
    );
    check(
      "skips node_modules package.json",
      !rep.findings.some((f) => f.file.includes("node_modules")),
    );
    check(
      "flags workflow single-line and multi-line run: lines",
      rep.findings.some(
        (f) => f.file === ".github/workflows/ci.yml" && f.line === 4 && f.tool === "eslint",
      ) &&
        rep.findings.some(
          (f) => f.file === ".github/workflows/ci.yml" && f.line === 6 && f.tool === "prettier",
        ) &&
        rep.findings.some(
          (f) => f.file === ".github/workflows/ci.yml" && f.line === 7 && f.tool === "ts-node",
        ),
      JSON.stringify(rep.findings.filter((f) => f.file.endsWith(".yml"))),
    );
  } finally {
    rmSync(bypassDir, { recursive: true, force: true });
  }
}

function typescriptVersionCases(): void {
  const ts5 = makeFixture({
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { typescript: "^5.7.3" },
    }),
  });
  const ts6 = makeFixture({
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { typescript: "~6.0.0" },
    }),
  });
  const ts7 = makeFixture({
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { typescript: "^7.0.2" },
    }),
  });
  const tsNative = makeFixture({
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { typescript: "^5.7.3", "@typescript/native-preview": "^7.0.0-dev" },
    }),
  });
  try {
    check(
      "typescript 5 is flagged",
      scanToolchain(ts5).findings.some((f) => f.tool === "typescript"),
    );
    check(
      "typescript 6 is flagged",
      scanToolchain(ts6).findings.some((f) => f.tool === "typescript"),
    );
    check(
      "typescript 7 is NOT flagged",
      !scanToolchain(ts7).findings.some((f) => f.tool === "typescript"),
    );
    check(
      "typescript 5 with @typescript/native-preview is NOT flagged",
      !scanToolchain(tsNative).findings.some((f) => f.tool === "typescript"),
    );
  } finally {
    rmSync(ts5, { recursive: true, force: true });
    rmSync(ts6, { recursive: true, force: true });
    rmSync(ts7, { recursive: true, force: true });
    rmSync(tsNative, { recursive: true, force: true });
  }
}

function allowAndDoctorCases(): void {
  // 1. Warning default + wired repo becomes partial when script bypasses guardrails
  const warnDir = makeFixture({
    ...WIRED_BASE,
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { "@agentvibes/guardrails": "^0.4.5", jest: "^29.0.0" },
      scripts: { lint: "guardrails lint", test: "jest" },
    }),
  });
  // 2. Allow with reason suppresses finding; error severity exits 0 when all allowed
  const allowOkDir = makeFixture({
    ...WIRED_BASE,
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { "@agentvibes/guardrails": "^0.4.5", jest: "^29.0.0" },
      scripts: { lint: "guardrails lint", test: "guardrails test" },
    }),
    ".agentvibes/project.toml": [
      "[toolchain]",
      'severity = "error"',
      "",
      "[[toolchain.allow]]",
      'tool = "jest"',
      'reason = "legacy snapshot tests still migrating to vitest"',
      "",
    ].join("\n"),
  });
  // 3. Allow without reason (empty / <why>) counts as withoutReason and fails error mode
  const allowMissingReasonDir = makeFixture({
    ...WIRED_BASE,
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { "@agentvibes/guardrails": "^0.4.5", jest: "^29.0.0" },
      scripts: { lint: "guardrails lint", test: "guardrails test" },
    }),
    ".agentvibes/project.toml": [
      "[toolchain]",
      'severity = "error"',
      "",
      "[[toolchain.allow]]",
      'tool = "jest"',
      'reason = "<why>"',
      "",
    ].join("\n"),
  });
  // 4. Error severity exits 1 and names each finding
  const errDir = makeFixture({
    ...WIRED_BASE,
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { "@agentvibes/guardrails": "^0.4.5", webpack: "^5.0.0" },
      scripts: { lint: "guardrails lint", build: "webpack" },
    }),
    ".agentvibes/project.toml": '[toolchain]\nseverity = "error"\n',
  });
  // 5. Off severity ignores findings and keeps wiring on
  const offDir = makeFixture({
    ...WIRED_BASE,
    "package.json": JSON.stringify({
      name: "example-app",
      devDependencies: { "@agentvibes/guardrails": "^0.4.5", webpack: "^5.0.0" },
      scripts: { lint: "guardrails lint", build: "webpack" },
    }),
    ".agentvibes/project.toml": '[toolchain]\nseverity = "off"\n',
  });
  // 6. Malformed [toolchain] config throws ToolchainConfigError
  const badDir = makeFixture({
    "package.json": '{"name":"example-app"}',
    ".agentvibes/project.toml": '[toolchain]\nseverity = "bogus"\n',
  });

  try {
    const warnDoc = spawnSync("node", [CLI, "doctor", "--json"], {
      cwd: warnDir,
      encoding: "utf8",
    });
    const warnJson = JSON.parse(warnDoc.stdout) as {
      wiring: { state: string };
      toolchain: { status: string; severity: string; findings: unknown[] };
    };
    check(
      "doctor warning keeps exit 0 and sets wiring partial",
      warnDoc.status === 0 &&
        warnJson.wiring.state === "partial" &&
        warnJson.toolchain.status === "read" &&
        warnJson.toolchain.severity === "warning" &&
        warnJson.toolchain.findings.length === 2,
      warnDoc.stdout,
    );

    const allowOkDoc = spawnSync("node", [CLI, "doctor", "--json"], {
      cwd: allowOkDir,
      encoding: "utf8",
    });
    const allowOkJson = JSON.parse(allowOkDoc.stdout) as {
      wiring: { state: string };
      toolchain: { findings: unknown[]; withoutReason: number; allowed: { matched: boolean }[] };
    };
    check(
      "allow with reason suppresses finding and passes error mode",
      allowOkDoc.status === 0 &&
        allowOkJson.wiring.state === "on" &&
        allowOkJson.toolchain.findings.length === 0 &&
        allowOkJson.toolchain.withoutReason === 0 &&
        allowOkJson.toolchain.allowed[0]?.matched === true,
      allowOkDoc.stdout,
    );

    const allowNoReasonDoc = spawnSync("node", [CLI, "doctor", "--json"], {
      cwd: allowMissingReasonDir,
      encoding: "utf8",
    });
    const allowNoReasonJson = JSON.parse(allowNoReasonDoc.stdout) as {
      toolchain: { findings: unknown[]; withoutReason: number };
    };
    check(
      "allow with placeholder reason counts as withoutReason and fails error mode",
      allowNoReasonDoc.status === 1 &&
        allowNoReasonJson.toolchain.withoutReason === 1 &&
        allowNoReasonJson.toolchain.findings.length === 1,
      allowNoReasonDoc.stdout,
    );

    const errDoc = spawnSync("node", [CLI, "doctor"], {
      cwd: errDir,
      encoding: "utf8",
    });
    check(
      "severity error makes doctor exit 1 and name each finding",
      errDoc.status === 1 &&
        errDoc.stdout.includes("webpack") &&
        errDoc.stdout.includes("script-bypass"),
      `exit=${errDoc.status}\n${errDoc.stdout}\n${errDoc.stderr}`,
    );

    const offDoc = spawnSync("node", [CLI, "doctor", "--json"], {
      cwd: offDir,
      encoding: "utf8",
    });
    const offJson = JSON.parse(offDoc.stdout) as {
      wiring: { state: string };
      toolchain: { severity: string; findings: unknown[] };
    };
    check(
      "severity off skips findings and keeps wiring on",
      offDoc.status === 0 &&
        offJson.wiring.state === "on" &&
        offJson.toolchain.severity === "off" &&
        offJson.toolchain.findings.length === 0,
      offDoc.stdout,
    );

    let threw = false;
    try {
      scanToolchain(badDir);
    } catch (err) {
      threw = err instanceof ToolchainConfigError;
    }
    check("invalid [toolchain] config throws ToolchainConfigError", threw);
  } finally {
    rmSync(warnDir, { recursive: true, force: true });
    rmSync(allowOkDir, { recursive: true, force: true });
    rmSync(allowMissingReasonDir, { recursive: true, force: true });
    rmSync(errDir, { recursive: true, force: true });
    rmSync(offDir, { recursive: true, force: true });
    rmSync(badDir, { recursive: true, force: true });
  }
}

function main(): number {
  findingKindsCases();
  typescriptVersionCases();
  allowAndDoctorCases();
  if (failed > 0) {
    console.error(`\n${failed} toolchain check(s) failed`);
    return 1;
  }
  console.log("\ntoolchain passed");
  return 0;
}

process.exitCode = main();
