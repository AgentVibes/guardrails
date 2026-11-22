import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OverrideConfigError } from "./overrideDeclarations.js";
import {
  CANON_OVERRIDDEN,
  collectOverrides,
  OVERRIDE_DECLARED_UNUSED,
  OVERRIDE_WITHOUT_REASON,
  type OverrideReport,
} from "./overrides.js";
import { packageRoot } from "./packagePaths.js";

// The overrides inventory (overrides.ts). One repo tree holds one override of
// every kind, half with a reason and half without; the test checks the
// inventory, the warnings, the declared-but-unused warning, the `--json`
// output of verify and doctor, and that warnings never change an exit code.
// The red case: a reason-less suppression MUST produce the warning — if the
// scan stops seeing it, the test fails.

const TOML = `[verify]
screens = "^src/screens/"
exclude = "^vendor/"

[metrics]
max_file_sloc = 800

[[override]]
kind = "verify-scope"
rule = "screens"
reason = "screens import their page store by design"

[[override]]
kind = "biome-rule"
rule = "suspicious/noConsole"
paths = ["**/scripts/**"]
reason = "scripts print to the terminal"

[[override]]
kind = "repo-rule-shadow"
rule = "catch-empty"
reason = "this repo also flags empty finally blocks"

[[override]]
kind = "metrics-limit"
rule = "max_file_sloc"
reason = ""

[[override]]
kind = "biome-rule"
rule = "style/useConst"
paths = ["gen/**"]
reason = "no such override exists"
`;

const TREE: Record<string, string> = {
  ".agentvibes/project.toml": TOML,
  "biome.json": `${JSON.stringify(
    {
      extends: ["@agentvibes/guardrails/biome"],
      overrides: [
        {
          includes: ["**/scripts/**"],
          linter: { rules: { suspicious: { noConsole: "off" } } },
        },
        { includes: ["**/bin/**"], linter: { rules: { suspicious: { noConsole: "off" } } } },
      ],
    },
    null,
    2,
  )}\n`,
  "sgconfig.yml": "ruleDirs:\n  - local-rules\n",
  "local-rules/catch-empty.yml":
    "id: catch-empty\nlanguage: typescript\nseverity: warning\nmessage: x\nrule:\n  pattern: console.log($$$)\n",
  "src/a.ts": [
    "// ast-grep-ignore: catch-empty -- the cleanup may fail and that is fine",
    "export const a = 1;",
    "// ast-grep-ignore: silent-default-return, no-as-any",
    "export const b = 2;",
    "// ast-grep-ignore",
    "export const c = 3;",
    "// biome-ignore lint/style/useConst: assigned in a loop",
    "export let d = 4;",
    "// biome-ignore lint/suspicious/noExplicitAny: <explanation>",
    "export const e = 5;",
    "const s = '// ast-grep-ignore: not-a-directive';",
    "",
  ].join("\n"),
  "src/b.tsx": [
    "export const B = () => (",
    "  <div>",
    "    {/* ast-grep-ignore: inline-map-row -- a three-item static list */}",
    "    <p />",
    "  </div>",
    ");",
    "",
  ].join("\n"),
};

function materialise(tree: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-overrides-"));
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

let failed = 0;
function expect(step: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`  ok  overrides: ${step}`);
    return;
  }
  failed += 1;
  console.error(
    `FAIL overrides: ${step}\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`,
  );
}

function key(r: OverrideReport): string[] {
  return r.overrides.map((o) => `${o.kind} ${o.rule} ${o.reason.status}`).sort();
}

function cli(dir: string, args: string[]): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: res.stdout };
}

// Rule fixtures: skipped only in this package's own source. RED both ways: a
// consumer's `rules/__fixtures__/` suppression is still an override, and the
// package's own fixture suppression is not one.
function fixtureScope(): void {
  const fixture = {
    "rules/__fixtures__/catch-empty/good.ts":
      "// ast-grep-ignore: catch-empty -- fixture for the suppression\nexport const g = 1;\n",
  };
  for (const [name, counted] of [
    ["a-consumer", true],
    ["@agentvibes/guardrails", false],
  ] as const) {
    const dir = materialise({ ...fixture, "package.json": `${JSON.stringify({ name })}\n` });
    try {
      const seen = collectOverrides(dir).overrides.some(
        (o) => o.file === "rules/__fixtures__/catch-empty/good.ts",
      );
      expect(
        `a rule-fixture suppression in a repo named ${name} is ${counted ? "" : "not "}an override`,
        seen === counted,
        collectOverrides(dir).overrides,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function main(): number {
  const dir = materialise(TREE);
  try {
    const report = collectOverrides(dir);
    const want = [
      "ast-grep-ignore * missing",
      "ast-grep-ignore catch-empty given",
      "ast-grep-ignore inline-map-row given",
      "ast-grep-ignore no-as-any missing",
      "ast-grep-ignore silent-default-return missing",
      "biome-ignore style/useConst given",
      "biome-ignore suspicious/noExplicitAny missing",
      "biome-rule suspicious/noConsole given",
      "biome-rule suspicious/noConsole missing",
      "metrics-limit max_file_sloc missing",
      "repo-rule-shadow catch-empty given",
      "verify-scope exclude missing",
      "verify-scope screens given",
    ];
    expect(
      "inventory lists every override with its reason status",
      JSON.stringify(key(report)) === JSON.stringify(want),
      {
        got: key(report),
        want,
      },
    );

    // RED: a reason-less suppression must be a warning.
    const noReason = report.findings.filter((f) => f.rule === OVERRIDE_WITHOUT_REASON);
    expect(
      "every reason-less override is an override-without-reason warning",
      noReason.length === want.filter((w) => w.endsWith("missing")).length &&
        noReason.every((f) => f.severity === "warning" && f.source === "override"),
      noReason,
    );
    expect(
      "the bare comma list names its line",
      noReason.some(
        (f) => f.file === "src/a.ts" && f.line === 3 && f.message.includes("no-as-any"),
      ),
      noReason,
    );
    // Policy: an override is a warning even WITH a reason.
    const overridden = report.findings.filter((f) => f.rule === CANON_OVERRIDDEN);
    expect(
      "every override, reasoned or not, is a canon-overridden warning",
      overridden.length === want.length &&
        overridden.every((f) => f.severity === "warning") &&
        overridden.some((f) =>
          f.message.includes("reason: the cleanup may fail and that is fine"),
        ) &&
        overridden.some((f) => f.message.includes("no reason given")),
      overridden,
    );
    const unused = report.findings.filter((f) => f.rule === OVERRIDE_DECLARED_UNUSED);
    expect(
      "a declaration that matches nothing is override-declared-unused",
      unused.length === 1 && unused[0]?.message.includes("style/useConst") === true,
      unused,
    );
    expect(
      "a string that only looks like a directive is not an override",
      !report.overrides.some((o) => o.rule === "not-a-directive"),
      report.overrides,
    );

    const verify = cli(dir, ["verify", "--json", "src"]);
    const vj = JSON.parse(verify.out) as { overrides: unknown[]; findings: { rule: string }[] };
    expect(
      "verify --json carries overrides and the warnings; warnings alone exit 0",
      verify.status === 0 &&
        Array.isArray(vj.overrides) &&
        vj.findings.some((f) => f.rule === OVERRIDE_WITHOUT_REASON),
      verify,
    );
    const doctor = cli(dir, ["doctor", "--json"]);
    const dj = JSON.parse(doctor.out) as { overrides: { status: string; overrides: unknown[] } };
    expect(
      "doctor --json carries the inventory",
      dj.overrides.status === "read" && dj.overrides.overrides.length === want.length,
      dj.overrides,
    );

    // A declaration file the gate cannot read fails loudly, never as "nothing declared".
    writeFileSync(join(dir, ".agentvibes/project.toml"), '[[override]]\nkind = "severity"\n');
    let threw = false;
    try {
      collectOverrides(dir);
    } catch (err) {
      threw = err instanceof OverrideConfigError;
    }
    expect("an unknown kind throws OverrideConfigError", threw, "did not throw");
    const bad = cli(dir, ["verify", "src"]);
    expect("verify exits 2 on an unreadable [[override]] table", bad.status === 2, bad);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  fixtureScope();
  if (failed > 0) return 1;
  console.log("\noverrides inventory passed");
  return 0;
}

process.exit(main());
