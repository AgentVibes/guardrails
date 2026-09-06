import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Regression fixtures for is-f58cd6b4 — `verify` ignored the consuming repo's
// own sgconfig.yml, so repo-local rules never ran and the finding count was of
// a smaller rule set than the repo had asked for, with nothing saying so.
//
// The fixture repo is the shape the bug was reported in: an `sgconfig.yml`
// listing BOTH the canon rule directory and a local one, a file that violates
// only the local rule, and a file that violates only a canon rule.
//
// Measured against the pre-fix build (HEAD's verify.ts, scanning only the
// package config): 4 of the 6 checks below fail — the local rule reports
// nothing, it gates nothing, a repo config without the canon ruleDir loses its
// local rules entirely, and an unparsable repo config reads as "no findings".
// The other two pass before and after; they pin that the fix did not cost the
// canon its coverage or start double-reporting it.

/** Violates only the repo-local rule; no canon rule matches `forbiddenCall()`. */
const LOCAL_ONLY = "export const boot = () => {\n  forbiddenCall()\n}\n";

/** Violates only a canon rule (`catch-empty`, error tier). */
const CANON_ONLY = "export const run = () => {\n  try { work() } catch (e) { }\n}\n";

const LOCAL_RULE = `id: no-forbidden-call
language: typescript
severity: error
message: |
  This repo forbids forbiddenCall(). Repo-local rule, not part of the canon.
rule:
  pattern: "forbiddenCall()"
`;

interface Run {
  status: number;
  out: string;
  findings: { rule: string; file: string; line: number }[];
}

function verify(cwd: string, target = "."): Run {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "verify", "--json", target], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  const out = `${res.stdout}${res.stderr}`;
  let findings: { rule: string; file: string; line: number }[] = [];
  try {
    findings = (
      JSON.parse(res.stdout) as { findings: { rule: string; file: string; line: number }[] }
    ).findings;
    // ast-grep-ignore: catch-empty -- non-JSON stdout IS the answer for the exit-2 path this test asserts; the caller reads `status` and `out`, and every assertion that wanted findings fails with the raw output attached
  } catch {
    findings = [];
  }
  return { status: res.status ?? -1, out, findings };
}

function makeRepo(sgconfig: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-repo-rules-"));
  mkdirSync(join(dir, ".ast-grep", "rules"), { recursive: true });
  writeFileSync(join(dir, ".ast-grep", "rules", "no-forbidden-call.yml"), LOCAL_RULE);
  writeFileSync(join(dir, "sgconfig.yml"), sgconfig);
  writeFileSync(join(dir, "local.ts"), LOCAL_ONLY);
  writeFileSync(join(dir, "canon.ts"), CANON_ONLY);
  return dir;
}

/** The config `guardrails init` writes, with the local ruleDir uncommented. */
const BOTH_DIRS = `ruleDirs:
  - ${join(packageRoot, "rules")}
  - .ast-grep/rules
`;

/** A repo whose config declares ONLY its local rules — the canon must survive. */
const LOCAL_DIR_ONLY = `ruleDirs:
  - .ast-grep/rules
`;

function expectStep(step: string, ok: boolean, detail: string): boolean {
  if (!ok) {
    console.error(`FAIL repo-rules: ${step}\n${detail}`);
    return false;
  }
  console.log(`  ok  repo-rules: ${step}`);
  return true;
}

function main(): number {
  const both = makeRepo(BOTH_DIRS);
  const localOnly = makeRepo(LOCAL_DIR_ONLY);
  const brokenConfig = makeRepo("ruleDirs: [\n");
  try {
    const r = verify(both);
    const local = r.findings.filter((f) => f.rule === "no-forbidden-call");
    const canon = r.findings.filter((f) => f.rule === "catch-empty");

    let ok = expectStep(
      "the repo's own rule reports (1 finding on local.ts)",
      local.length === 1 && local[0]?.file.endsWith("local.ts") === true,
      r.out,
    );
    // Scoped to local.ts so the exit code cannot be explained by the canon
    // finding in canon.ts — this is the local rule gating, on its own.
    const lonly = verify(both, "local.ts");
    ok =
      expectStep(
        "a repo-local error-tier finding gates verify on its own (exit 1)",
        lonly.status === 1 && lonly.findings.every((f) => f.rule === "no-forbidden-call"),
        `exit ${lonly.status}\n${lonly.out}`,
      ) && ok;
    ok =
      expectStep(
        "the canon still reports alongside it (catch-empty on canon.ts)",
        canon.length === 1,
        r.out,
      ) && ok;

    // The overlap: the repo config lists the canon ruleDir too, so without
    // dedupe every canon finding arrives once per config.
    const keys = r.findings.map((f) => `${f.rule}\0${f.file}\0${f.line}`);
    ok =
      expectStep(
        "the canon ruleDir listed in both configs is not double-reported",
        new Set(keys).size === keys.length,
        `${keys.length} findings, ${new Set(keys).size} distinct:\n${r.out}`,
      ) && ok;

    // A repo config that forgets the canon must not silently lose the canon —
    // that is this same bug pointing the other way.
    const lr = verify(localOnly);
    ok =
      expectStep(
        "a repo config without the canon ruleDir keeps canon coverage",
        lr.findings.some((f) => f.rule === "catch-empty") &&
          lr.findings.some((f) => f.rule === "no-forbidden-call"),
        lr.out,
      ) && ok;

    // A config ast-grep cannot parse must fail loudly (exit 2), never read as
    // "no findings" — ast-grep exits 8 there and writes nothing to stdout.
    const br = verify(brokenConfig);
    ok =
      expectStep(
        "an unparsable repo config exits 2 with the reason, not 0 with silence",
        br.status === 2 && br.out.includes("ast-grep exited"),
        `exit ${br.status}\n${br.out}`,
      ) && ok;

    console.log("");
    if (!ok) {
      console.error("repo-local rule assertions FAILED");
      return 1;
    }
    console.log("repo-local rule fixtures passed");
    return 0;
  } finally {
    for (const d of [both, localOnly, brokenConfig]) rmSync(d, { recursive: true, force: true });
  }
}

process.exit(main());
