import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { presetDrift } from "./presetDrift.js";

// Fixtures for the preset-drift guard (is-9c7a78d7). The migration epic
// is-a70a5963 collapses 37 hand-rolled biome configs into one preset; this is
// what stops a repo re-growing its own afterwards.
//
// The fixtures live in test/preset-drift/ (see its README): `valid/` must pass,
// `invalid/<key>--<name>.json` must report drift with that finding key. Every
// one is run through the library AND the CLI, because the exit codes are the
// gate: drift fails `verify` (exit 2) and `doctor` (exit 1) in every repo, with
// no opt-in anywhere in the tree.

const FIXTURES = join(packageRoot, "test", "preset-drift");
const CLEAN_TS = "export const two = 1 + 1;\n";

interface Fixture {
  name: string;
  /** The finding key an invalid fixture must produce; undefined for valid ones. */
  expectKey: string | undefined;
  dir: string;
}

/** Write one fixture tree (path → JSON value, or raw text) into a fresh temp repo. */
function materialise(file: string): string {
  const tree = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const dir = mkdtempSync(join(tmpdir(), "guardrails-preset-"));
  writeFileSync(join(dir, "a.ts"), CLEAN_TS);
  for (const [path, content] of Object.entries(tree)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  return dir;
}

function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const kind of ["valid", "invalid"] as const) {
    for (const file of readdirSync(join(FIXTURES, kind)).sort()) {
      if (!file.endsWith(".json")) continue;
      const base = file.replace(/\.json$/, "");
      out.push({
        name: `${kind}/${base}`,
        expectKey: kind === "valid" ? undefined : base.split("--")[0],
        dir: materialise(join(FIXTURES, kind, file)),
      });
    }
  }
  return out;
}

function run(cwd: string, command: string): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), command], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function expectStep(step: string, ok: boolean, detail: string): boolean {
  if (!ok) {
    console.error(`FAIL preset-drift: ${step}\n${detail}`);
    return false;
  }
  console.log(`  ok  preset-drift: ${step}`);
  return true;
}

function checkFixture(f: Fixture): boolean {
  const findings = presetDrift(f.dir);
  const shown = JSON.stringify(findings, null, 2);
  const verify = run(f.dir, "verify");
  const doctor = run(f.dir, "doctor");
  if (f.expectKey === undefined) {
    return (
      expectStep(`${f.name}: no drift`, findings.length === 0, shown) &&
      expectStep(
        `${f.name}: verify exits 0`,
        verify.status === 0 && !verify.out.includes("biome preset drift"),
        `exit ${verify.status}\n${verify.out}`,
      ) &&
      expectStep(
        `${f.name}: doctor prints "no drift" and exits 0`,
        doctor.status === 0 && doctor.out.includes("biome preset  no drift"),
        `exit ${doctor.status}\n${doctor.out}`,
      )
    );
  }
  return (
    expectStep(
      `${f.name}: drift with key "${f.expectKey}"`,
      findings.some((x) => x.key === f.expectKey),
      shown,
    ) &&
    expectStep(
      `${f.name}: verify exits 2 and names the drift`,
      verify.status === 2 && verify.out.includes("biome preset drift"),
      `exit ${verify.status}\n${verify.out}`,
    ) &&
    expectStep(
      `${f.name}: doctor exits 1 and prints DRIFT`,
      doctor.status === 1 && doctor.out.includes("biome preset  DRIFT"),
      `exit ${doctor.status}\n${doctor.out}`,
    )
  );
}

function main(): number {
  const fixtures = loadFixtures();
  try {
    let ok = true;
    const kinds = new Set(fixtures.filter((f) => f.expectKey).map((f) => f.expectKey));
    ok =
      expectStep(
        "fixtures cover all five drift keys",
        ["extends", "own-keys", "overrides", "extra-config", "no-root-config"].every((k) =>
          kinds.has(k),
        ),
        [...kinds].join(", "),
      ) && ok;

    for (const f of fixtures) ok = checkFixture(f) && ok;

    // The message has to name WHAT drifted, not only that something did.
    const byName = (n: string): Fixture | undefined => fixtures.find((f) => f.name === n);
    const own = byName("invalid/own-keys--restates-preset");
    const ownDetail = own
      ? (presetDrift(own.dir).find((x) => x.key === "own-keys")?.detail ?? "")
      : "";
    ok =
      expectStep(
        "own-keys names formatter, linter, assist, javascript.formatter and json.formatter",
        ["formatter", "linter", "assist", "javascript.formatter", "json.formatter"].every((k) =>
          ownDetail.includes(k),
        ),
        ownDetail,
      ) && ok;
    const wide = byName("invalid/overrides--other-rule");
    const wideDetail = wide
      ? (presetDrift(wide.dir).find((x) => x.key === "overrides")?.detail ?? "")
      : "";
    ok =
      expectStep(
        "overrides names each offending entry by index",
        wideDetail.includes("overrides[0]") && wideDetail.includes("overrides[1].formatter"),
        wideDetail,
      ) && ok;

    const noBiome = mkdtempSync(join(tmpdir(), "guardrails-preset-"));
    writeFileSync(join(noBiome, "a.ts"), CLEAN_TS);
    ok =
      expectStep(
        "a repo with no biome config at all reports no drift",
        presetDrift(noBiome).length === 0,
        JSON.stringify(presetDrift(noBiome)),
      ) && ok;
    rmSync(noBiome, { recursive: true, force: true });

    console.log("");
    if (!ok) {
      console.error("preset-drift assertions FAILED");
      return 1;
    }
    console.log(`preset-drift fixtures passed (${fixtures.length} fixtures)`);
    return 0;
  } finally {
    for (const f of fixtures) rmSync(f.dir, { recursive: true, force: true });
  }
}

process.exit(main());
