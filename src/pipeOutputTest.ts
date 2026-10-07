import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// `--json` read through a pipe must arrive whole (is-5cc188b7). The CLI used to
// end with `process.exit(code)`; stdout to a pipe is asynchronous in Node, so
// everything past the first 64 KiB the pipe buffer took was dropped — measured
// `metrics --json . | wc -c` = 65536 against 128389 bytes redirected to a file.
// The fixture is sized to produce well over 64 KiB, so the old CLI fails here.

const CLI = join(packageRoot, "dist", "cli.js");
const COMPONENTS = 400;

function sh(cwd: string, script: string): { status: number; stdout: string } {
  const res = spawnSync("sh", ["-c", script], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout };
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-pipe-"));
  try {
    for (let i = 0; i < COMPONENTS; i++) {
      writeFileSync(
        join(dir, `Card${i}.tsx`),
        `export const Card${i} = ({ a, b }: { a: string; b: number }) => <div title={a}>{b}</div>;\n`,
      );
    }
    sh(dir, "git init -q && git add -A");

    const toFile = sh(dir, `node "${CLI}" metrics --json . > out.json`);
    const fileBytes = readFileSync(join(dir, "out.json"), "utf8");
    const piped = sh(dir, `node "${CLI}" metrics --json . | cat`);

    if (fileBytes.length <= 64 * 1024) {
      console.error(
        `FAIL pipe-output: fixture produced only ${fileBytes.length} bytes — it must exceed 64 KiB to test anything`,
      );
      return 1;
    }
    if (toFile.status !== piped.status) {
      console.error(
        `FAIL pipe-output: exit ${piped.status} through a pipe, ${toFile.status} to a file`,
      );
      return 1;
    }
    if (piped.stdout !== fileBytes) {
      console.error(
        `FAIL pipe-output: ${piped.stdout.length} bytes through a pipe, ${fileBytes.length} to a file`,
      );
      return 1;
    }
    JSON.parse(piped.stdout);
    console.log(
      `  ok  pipe-output: ${fileBytes.length} bytes through a pipe, identical to the file`,
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = main();
