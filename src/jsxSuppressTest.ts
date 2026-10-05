import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// `{/* ast-grep-ignore: <rule> -- <why> */}` (is-18ff62fb). Inside JSX children
// `//` is not a comment, it is text that renders, so ast-grep's own line-comment
// form cannot be used there — and ast-grep does not recognise the bracketed
// spelling. Findings on markup therefore had no suppression at all.
//
// Four directions, all executed, because a suppression that swallows too much
// is worse than none:
//   1. the bracketed form suppresses the rule it names
//   2. the same file without it still reports (the fixture is not inert)
//   3. it does NOT suppress a different rule on the same line
//   4. without a `-- <why>` reason it does not apply, exactly as the line form

const WITH = `export const A = ({ v }: { v: string }) => (
  <div>
    {/* ast-grep-ignore: classname-not-composed -- the fonts are CSS variables, not variants */}
    <span className={\`base \${v}\`}>x</span>
  </div>
);
`;
const WITHOUT = `export const B = ({ v }: { v: string }) => (
  <div>
    <span className={\`base \${v}\`}>x</span>
  </div>
);
`;
const WRONG_RULE = `export const C = ({ v }: { v: string }) => (
  <div>
    {/* ast-grep-ignore: inline-map-row -- names a different rule than the one that fires */}
    <span className={\`base \${v}\`}>x</span>
  </div>
);
`;
const NO_REASON = `export const D = ({ v }: { v: string }) => (
  <div>
    {/* ast-grep-ignore: classname-not-composed */}
    <span className={\`base \${v}\`}>x</span>
  </div>
);
`;

let failed = 0;
const fail = (m: string): void => {
  console.error(`FAIL jsx-suppress: ${m}`);
  failed++;
};

function run(dir: string, command: "verify" | "verify-diff"): string {
  const args = command === "verify" ? ["verify", "."] : ["verify-diff"];
  const r = spawnSync("node", [join(packageRoot, "dist", "cli.js"), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return `${r.stdout}${r.stderr}`;
}

function fixture(name: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), "guardrails-jsxsup-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", name), source);
  return root;
}

const cases: Array<[string, string, boolean, string]> = [
  ["a.tsx", WITH, false, "the bracketed form suppresses the rule it names"],
  ["b.tsx", WITHOUT, true, "the same markup without it still reports"],
  ["c.tsx", WRONG_RULE, true, "a directive naming another rule suppresses nothing"],
  ["d.tsx", NO_REASON, true, "a directive with no `-- <why>` reason does not apply"],
];

for (const [name, source, expectReported, what] of cases) {
  const root = fixture(name, source);
  try {
    // verify-diff applies the same suppressions (it once skipped this filter
    // and gated findings verify exempts). The fixture is not a git repo, so
    // verify-diff gates the whole tree here.
    for (const command of ["verify", "verify-diff"] as const) {
      const out = run(root, command);
      const reported = out.includes("classname-not-composed");
      if (reported !== expectReported) {
        fail(
          `${command}: ${what} — expected ${expectReported ? "a finding" : "no finding"}, got the opposite:\n${out}`,
        );
      } else {
        console.log(`  ok  jsx-suppress (${command}): ${what}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`jsx-suppress: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("jsx-suppress: all checks passed");
