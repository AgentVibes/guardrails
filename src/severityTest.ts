import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// Fixtures for the [severity] raise. Three directions, all executed:
//   1. without a raise, a warning-tier finding does not gate verify (exit 0)
//   2. with `zod-optional-nullable = "error"`, the SAME code gates (exit 1)
//      and the finding reports at error severity
//   3. a downgrade attempt (or unknown rule id) is refused loudly (exit 2) —
//      a config the gate cannot honour must never be silently dropped

const ZOD_BAD =
  'import { z } from "zod";\nexport const s = z.object({ a: z.string().optional().nullable() });\n';

function verify(cwd: string): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "verify", "schema.ts"], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function expectStep(step: string, ok: boolean, detail: string): boolean {
  if (!ok) {
    console.error(`FAIL severity: ${step}\n${detail}`);
    return false;
  }
  console.log(`  ok  severity: ${step}`);
  return true;
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-severity-"));
  try {
    writeFileSync(join(dir, "schema.ts"), ZOD_BAD);

    const plain = verify(dir);
    if (
      !expectStep(
        "warning-tier finding alone does not gate (exit 0)",
        plain.status === 0 && plain.out.includes("warning[zod-optional-nullable]"),
        plain.out,
      )
    ) {
      return 1;
    }

    mkdirSync(join(dir, ".agentvibes"));
    const toml = join(dir, ".agentvibes", "project.toml");
    writeFileSync(toml, '[severity]\n"zod-optional-nullable" = "error"\n');
    const raised = verify(dir);
    if (
      !expectStep(
        "raised rule gates the same code (exit 1, error severity)",
        raised.status === 1 && raised.out.includes("error[zod-optional-nullable]"),
        raised.out,
      )
    ) {
      return 1;
    }

    writeFileSync(toml, '[severity]\n"as-any-escape" = "warning"\n');
    const downgrade = verify(dir);
    if (
      !expectStep(
        "downgrade attempt refused (exit 2)",
        downgrade.status === 2 && downgrade.out.includes("only raises"),
        downgrade.out,
      )
    ) {
      return 1;
    }

    writeFileSync(toml, '[severity]\n"no-such-rule" = "error"\n');
    const unknown = verify(dir);
    if (
      !expectStep(
        "unknown rule id refused (exit 2)",
        unknown.status === 2 && unknown.out.includes("unknown rule"),
        unknown.out,
      )
    ) {
      return 1;
    }

    console.log("severity-raise fixtures passed");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
