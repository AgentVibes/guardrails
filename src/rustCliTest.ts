import "./testIsolation.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { packageRoot } from "./packagePaths.js";

// The Rust adapter end to end: the CLI on a two-crate Cargo workspace made
// in a temp directory, with real cargo, clippy and rustfmt. init → doctor →
// verify (clean) → verify-diff (new findings on changed lines only) →
// hook-postedit → a build that does not compile (exit 2, never "0 findings").
//
// cargo is required: without it this test FAILS rather than skipping, so a
// machine that cannot run the Rust path cannot report it green. One
// CARGO_TARGET_DIR under the temp root is shared by every step.

let failed = 0;
function expect(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed++;
  console.error(
    `FAIL ${name}\n  ${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`,
  );
}

interface Ran {
  status: number;
  out: string;
  stdout: string;
}

let env: NodeJS.ProcessEnv = process.env;

function run(cwd: string, cmd: string, args: string[], input?: string): Ran {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env, input, timeout: 600_000 });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}`, stdout: res.stdout };
}

function cli(cwd: string, ...args: string[]): Ran {
  return run(cwd, "node", [join(packageRoot, "dist", "cli.js"), ...args]);
}

function git(cwd: string, ...args: string[]): void {
  const r = run(cwd, "git", args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const crate = (name: string) =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;

// Clean under the canon: const where it can be, #[must_use] on pure fns, rustfmt layout.
const CLEAN_A = "#[must_use]\npub const fn add(x: i32, y: i32) -> i32 {\n    x + y\n}\n";
const CLEAN_B = "#[must_use]\npub const fn twice(x: i32) -> i32 {\n    x * 2\n}\n";
const CI =
  "on: push\njobs:\n  rust:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: cargo clippy --all-targets -- -D warnings\n      - run: cargo fmt --all --check\n";

const DoctorJson = z
  .object({
    languages: z.object({ languages: z.array(z.string()) }).loose(),
    wiring: z
      .object({ checks: z.array(z.object({ id: z.string(), status: z.string() }).loose()) })
      .loose(),
  })
  .loose();

function steps(ws: string): void {
  write(ws, {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
    "crates/a/Cargo.toml": crate("a"),
    "crates/a/src/lib.rs": CLEAN_A,
    "crates/b/Cargo.toml": crate("b"),
    "crates/b/src/lib.rs": CLEAN_B,
    ".gitignore": "target/\n",
  });
  git(ws, "init", "-q", "-b", "main");
  git(ws, "config", "user.email", "test@example.invalid");
  git(ws, "config", "user.name", "test");

  const init = cli(ws, "init");
  const manifest = readFileSync(join(ws, "Cargo.toml"), "utf8");
  expect(
    "init writes the canon, [lints] inheritance, rust-toolchain.toml, clippy.toml and the hooks",
    init.status === 0 &&
      manifest.includes("[workspace.lints.clippy]") &&
      manifest.includes('unwrap_used = "deny"') &&
      readFileSync(join(ws, "crates/a/Cargo.toml"), "utf8").includes("[lints]\nworkspace = true") &&
      existsSync(join(ws, "rust-toolchain.toml")) &&
      existsSync(join(ws, "clippy.toml")) &&
      readFileSync(join(ws, ".claude/settings.json"), "utf8").includes("hook-postedit") &&
      !existsSync(join(ws, "sgconfig.yml")),
    init.out,
  );
  expect("init a second time changes nothing", cli(ws, "init").out.includes("skipped"), null);
  write(ws, { ".github/workflows/ci.yml": CI });
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "init");

  const doctor = cli(ws, "doctor", "--json");
  const d = DoctorJson.safeParse(JSON.parse(doctor.stdout || "{}"));
  const checks = d.success ? d.data.wiring.checks.map((c) => `${c.id}=${c.status}`).join(" ") : "";
  expect(
    "doctor: rust detected, every Rust wiring check passes, exit 0",
    doctor.status === 0 &&
      d.success &&
      d.data.languages.languages.join() === "rust" &&
      checks ===
        "hook-postedit=pass hook-stop=pass rust.clippy-strict=pass rust.lints-inherited=pass rust.toolchain=pass rust.ci=pass",
    { status: doctor.status, checks, out: doctor.out },
  );

  const clean = cli(ws, "verify");
  expect("verify on clean code exits 0", clean.status === 0, clean.out);

  git(ws, "checkout", "-qb", "feat");
  write(ws, {
    "crates/a/src/lib.rs": `${CLEAN_A}\n#[must_use]\npub fn first(v: &[i32]) -> i32 {\n    *v.first().unwrap()\n}\n\n#[allow(dead_code)]\nfn unused() {}\n`,
  });
  const postedit = (file: string) =>
    run(
      ws,
      "node",
      [join(packageRoot, "dist", "cli.js"), "hook-postedit"],
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(ws, file) } }),
    );
  const hook = postedit("crates/a/src/lib.rs");
  expect(
    "hook-postedit on an edited .rs file blocks on the new clippy finding",
    hook.out.includes('"decision":"block"') &&
      hook.out.includes("error[clippy::unwrap_used]") &&
      hook.out.includes("#[expect("),
    hook.out,
  );
  git(ws, "commit", "-qam", "feat");
  const inherited = postedit("crates/a/src/lib.rs");
  expect(
    "hook-postedit: findings on lines already committed only warn",
    !inherited.out.includes('"decision":"block"') &&
      inherited.out.includes("warning[clippy::unwrap_used]"),
    inherited.out,
  );
  const diff = cli(ws, "verify-diff", "--base", "main");
  expect(
    "verify-diff: the new unwrap and the reasonless allow fail, exit 1",
    diff.status === 1 &&
      diff.out.includes("clippy::unwrap_used") &&
      diff.out.includes("crates/a/src/lib.rs:8") &&
      diff.out.includes("clippy::allow_attributes"),
    diff.out,
  );
  expect(
    "verify-diff prints the Rust suppression hint, not the TypeScript one",
    diff.out.includes("#[expect(") && !diff.out.includes("ast-grep-ignore"),
    diff.out,
  );
  const overrides = cli(ws, "verify");
  expect(
    "verify lists the #[allow] as canon-overridden and override-without-reason",
    overrides.out.includes("canon-overridden") &&
      overrides.out.includes("override-without-reason") &&
      overrides.out.includes("dead_code"),
    overrides.out,
  );

  // rustfmt-clean, so the only problem is the type error.
  write(ws, { "crates/b/src/lib.rs": 'pub fn broken() -> i32 {\n    "x"\n}\n' });
  const broken = cli(ws, "verify");
  expect(
    "a build that does not compile: verify exits 2 and names the error, never 0 findings",
    broken.status === 2 && broken.out.includes("could not run") && broken.out.includes("E0308"),
    broken.out,
  );
  const brokenHook = postedit("crates/b/src/lib.rs");
  expect(
    "hook-postedit never fails an edit for a tooling problem: exit 0 with a note",
    brokenHook.status === 0 && brokenHook.out.includes("could not run"),
    brokenHook.out,
  );
}

function main(): number {
  const base = mkdtempSync(join(tmpdir(), "guardrails-rust-cli-"));
  try {
    env = { ...process.env, CARGO_TARGET_DIR: join(base, "target"), CARGO_TERM_COLOR: "never" };
    const cargo = spawnSync("cargo", ["clippy", "--version"], { encoding: "utf8", env });
    if (cargo.error !== undefined || cargo.status !== 0) {
      console.error(
        `FAIL rust CLI: cargo clippy is not available (${cargo.error?.message ?? cargo.stderr}); install Rust with clippy and rustfmt (mise.toml)`,
      );
      return 1;
    }
    const ws = join(base, "ws");
    mkdirSync(ws);
    steps(ws);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`\n${failed} Rust CLI check(s) failed`);
    return 1;
  }
  console.log("\nRust CLI checks passed");
  return 0;
}

process.exit(main());
