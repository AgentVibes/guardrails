import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { presetDrift } from "./presetDrift.js";

// Fixtures for the preset-drift guard (is-9c7a78d7). The migration epic
// is-a70a5963 collapses 37 hand-rolled biome configs into one preset; this is
// what stops a repo re-growing its own afterwards.
//
// Both directions are executed, and so is the opt-in switch: a repo that has
// not yet migrated must SEE its drift and still exit 0, and the same repo with
// `[biome] preset = "enforced"` must exit 2. A guard that only ever ran in the
// enforced direction would not prove the unenforced one is quiet.

const CLEAN_TS = "export const two = 1 + 1;\n";

/** The config `guardrails init` writes, plus the two allowances. */
const CONFORMING = JSON.stringify(
  {
    $schema: "https://biomejs.dev/schemas/2.5.10/schema.json",
    extends: ["@agentvibes/guardrails/biome"],
    // Scoping its own paths is the repo's business, not the preset's.
    files: { includes: ["**/*.ts", "!**/dist"] },
    // A CLI has to print; this is the one rule an override may touch.
    overrides: [{ includes: ["src/**"], linter: { rules: { suspicious: { noConsole: "off" } } } }],
  },
  null,
  2,
);

const NO_EXTENDS = JSON.stringify({ formatter: { indentWidth: 4 } }, null, 2);

const OWN_KEYS = JSON.stringify(
  {
    extends: ["@agentvibes/guardrails/biome"],
    formatter: { lineWidth: 80 },
    linter: { rules: { style: { useConst: "off" } } },
    assist: { enabled: false },
    javascript: { formatter: { quoteStyle: "single" } },
    json: { formatter: { indentWidth: 4 } },
  },
  null,
  2,
);

const WIDE_OVERRIDE = JSON.stringify(
  {
    extends: ["@agentvibes/guardrails/biome"],
    overrides: [
      { includes: ["src/**"], linter: { rules: { style: { useConst: "off" } } } },
      { includes: ["gen/**"], formatter: { enabled: false } },
    ],
  },
  null,
  2,
);

interface Repo {
  dir: string;
}

function makeRepo(opts: { biome?: string; secondConfig?: string; enforced?: boolean }): Repo {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-preset-"));
  writeFileSync(join(dir, "a.ts"), CLEAN_TS);
  if (opts.biome !== undefined) writeFileSync(join(dir, "biome.json"), opts.biome);
  if (opts.secondConfig !== undefined) {
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    writeFileSync(join(dir, "packages", "web", "biome.json"), opts.secondConfig);
  }
  if (opts.enforced === true) {
    mkdirSync(join(dir, ".agentvibes"), { recursive: true });
    writeFileSync(join(dir, ".agentvibes", "project.toml"), '[biome]\npreset = "enforced"\n');
  }
  return { dir };
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

function main(): number {
  const repos: Repo[] = [];
  const make = (o: Parameters<typeof makeRepo>[0]): Repo => {
    const r = makeRepo(o);
    repos.push(r);
    return r;
  };
  try {
    let ok = true;

    // ── detection, key by key ────────────────────────────────────────────
    const conforming = make({ biome: CONFORMING });
    ok =
      expectStep(
        "a conforming config reports no drift (extends + files + noConsole override)",
        presetDrift(conforming.dir).length === 0,
        JSON.stringify(presetDrift(conforming.dir), null, 2),
      ) && ok;

    const noBiome = make({});
    ok =
      expectStep(
        "a repo with no biome config at all reports no drift",
        presetDrift(noBiome.dir).length === 0,
        JSON.stringify(presetDrift(noBiome.dir), null, 2),
      ) && ok;

    const noExtends = make({ biome: NO_EXTENDS });
    ok =
      expectStep(
        "(a) a config that does not extend the preset is drift",
        presetDrift(noExtends.dir).some((f) => f.key === "extends"),
        JSON.stringify(presetDrift(noExtends.dir), null, 2),
      ) && ok;

    const ownKeys = make({ biome: OWN_KEYS });
    const ownDetail = presetDrift(ownKeys.dir).find((f) => f.key === "own-keys")?.detail ?? "";
    ok =
      expectStep(
        "(b) formatter, linter, assist, javascript.formatter and json.formatter are all named",
        ["formatter", "linter", "assist", "javascript.formatter", "json.formatter"].every((k) =>
          ownDetail.includes(k),
        ),
        ownDetail,
      ) && ok;

    const wide = make({ biome: WIDE_OVERRIDE });
    const wideDetail = presetDrift(wide.dir).find((f) => f.key === "overrides")?.detail ?? "";
    ok =
      expectStep(
        "(b) an override touching anything but suspicious.noConsole is drift",
        wideDetail.includes("overrides[0]") && wideDetail.includes("overrides[1].formatter"),
        wideDetail,
      ) && ok;

    const second = make({ biome: CONFORMING, secondConfig: CONFORMING });
    ok =
      expectStep(
        "(c) a second biome.json in the tree is drift even when both conform",
        presetDrift(second.dir).some((f) => f.key === "extra-config"),
        JSON.stringify(presetDrift(second.dir), null, 2),
      ) && ok;

    // ── the opt-in switch, through the CLI ───────────────────────────────
    const unenforced = make({ biome: NO_EXTENDS });
    const u = run(unenforced.dir, "verify");
    ok =
      expectStep(
        "unenforced: verify SAYS the drift and still exits 0",
        u.status === 0 && u.out.includes("biome preset drift") && u.out.includes("Not gated here"),
        `exit ${u.status}\n${u.out}`,
      ) && ok;

    const enforced = make({ biome: NO_EXTENDS, enforced: true });
    const e = run(enforced.dir, "verify");
    ok =
      expectStep(
        "enforced: the same repo exits 2 with the offending keys named",
        e.status === 2 && e.out.includes('biome.json has no "extends"'),
        `exit ${e.status}\n${e.out}`,
      ) && ok;

    const enforcedOk = make({ biome: CONFORMING, enforced: true });
    const eo = run(enforcedOk.dir, "verify");
    ok =
      expectStep(
        "enforced + conforming: verify runs normally (exit 0, no drift line)",
        eo.status === 0 && !eo.out.includes("biome preset drift"),
        `exit ${eo.status}\n${eo.out}`,
      ) && ok;

    const d = run(enforced.dir, "doctor");
    ok =
      expectStep(
        "enforced: doctor exits 1 and prints the drift",
        d.status === 1 && d.out.includes("DRIFT (enforced here)"),
        `exit ${d.status}\n${d.out}`,
      ) && ok;

    const du = run(unenforced.dir, "doctor");
    ok =
      expectStep(
        "unenforced: doctor still REPORTS the drift, exit unchanged",
        du.out.includes("drift (not enforced here yet)"),
        `exit ${du.status}\n${du.out}`,
      ) && ok;

    console.log("");
    if (!ok) {
      console.error("preset-drift assertions FAILED");
      return 1;
    }
    console.log("preset-drift fixtures passed");
    return 0;
  } finally {
    for (const r of repos) rmSync(r.dir, { recursive: true, force: true });
  }
}

process.exit(main());
