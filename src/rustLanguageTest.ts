import "./testIsolation.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectLanguages, resolveLanguages } from "./lang/languages.js";
import { canonLints, compareLints, lintLine, parseLintTables } from "./lang/rust/lintTable.js";
import { rustWiringChecks } from "./lang/rust/rustWiring.js";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { detectWiring } from "./wiring.js";

// Language detection and the [languages] table (lang/languages.ts), the
// Cargo.toml lint-table comparison against the canon (lintTable.ts), and the
// Rust wiring checks (rustWiring.ts), on small trees in a temp directory.
// No cargo needed: everything here reads files.

let failed = 0;
function expect(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}\n  ${JSON.stringify(detail, null, 2)}`);
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-rust-lang-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function withTree(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = tree(files);
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CRATE = (name: string, extra = ""): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`;
const INHERIT = "\n[lints]\nworkspace = true\n";

/** The canon, as a workspace root writes it (what `guardrails init` appends). */
const CANON_WS = `[workspace]
members = ["crates/*"]

[workspace.lints.rust]
unsafe_code = "deny"

[workspace.lints.clippy]
pedantic = { level = "warn", priority = -1 }
nursery = { level = "deny", priority = -1 }
unwrap_used = "deny"
expect_used = "forbid"
panic = "deny"
todo = "deny"
unimplemented = "deny"
dbg_macro = "deny"
allow_attributes = "deny"
allow_attributes_without_reason = "deny"
undocumented_unsafe_blocks = "deny"
`;

function detection(): void {
  withTree({ "package.json": "{}" }, (d) => {
    const ids = detectLanguages(d).map((l) => l.id);
    expect("package.json alone → typescript", ids.join() === "typescript", ids);
  });
  withTree({ "Cargo.toml": CRATE("x"), "src/lib.rs": "" }, (d) => {
    const ids = detectLanguages(d).map((l) => l.id);
    expect("Cargo.toml alone → rust", ids.join() === "rust", ids);
  });
  withTree(
    { "package.json": "{}", "tsconfig.json": "{}", "src-tauri/Cargo.toml": CRATE("app") },
    (d) => {
      const ids = detectLanguages(d).map((l) => l.id);
      expect("package.json + nested Cargo.toml → mixed", ids.join() === "typescript,rust", ids);
    },
  );
  withTree({ "node_modules/dep/Cargo.toml": CRATE("dep"), "package.json": "{}" }, (d) => {
    const ids = detectLanguages(d).map((l) => l.id);
    expect("a Cargo.toml under node_modules is not the repo's", ids.join() === "typescript", ids);
  });
  withTree({ "README.md": "x" }, (d) => {
    const set = resolveLanguages(d);
    expect(
      "nothing detected → typescript by default",
      set.languages.join() === "typescript" && set.source === "default",
      set,
    );
  });
  withTree(
    {
      "package.json": "{}",
      "Cargo.toml": CRATE("x"),
      ".agentvibes/project.toml": '[languages]\nenabled = ["rust"]\n',
    },
    (d) => {
      const set = resolveLanguages(d);
      expect(
        "[languages] enabled overrides detection",
        set.languages.join() === "rust" && set.source === "config",
        set,
      );
    },
  );
  for (const [name, body] of [
    ["an unknown language", '[languages]\nenabled = ["go"]\n'],
    ["an empty list", "[languages]\nenabled = []\n"],
    ["an unknown key", '[languages]\nenabled = ["rust"]\nauto = true\n'],
  ] as const) {
    withTree({ ".agentvibes/project.toml": body }, (d) => {
      let thrown: unknown;
      try {
        resolveLanguages(d);
      } catch (err) {
        thrown = err;
      }
      expect(
        `[languages] with ${name} is a config error`,
        thrown instanceof OverrideConfigError,
        String(thrown),
      );
    });
  }
}

function lintTables(): void {
  const canon = canonLints();
  const parse = (toml: Record<string, Record<string, unknown>>) => parseLintTables(toml).tables;
  const exact = compareLints(canon, canon);
  expect("the canon meets itself", exact.gaps.length === 0 && exact.overrides.length === 0, exact);

  const stricter = parse({
    rust: { unsafe_code: "forbid" },
    clippy: {
      ...Object.fromEntries(Object.keys(canon.clippy ?? {}).map((k) => [k, "deny"])),
      pedantic: { level: "deny", priority: -2 },
      nursery: { level: "warn", priority: -1 },
    },
  });
  const s = compareLints(stricter, canon);
  expect("stricter levels and a lower priority still meet the canon", s.gaps.length === 0, s);

  const weaker = parse({
    rust: { unsafe_code: "deny" },
    clippy: {
      ...Object.fromEntries(Object.keys(canon.clippy ?? {}).map((k) => [k, "deny"])),
      pedantic: { level: "warn", priority: -1 },
      nursery: "warn",
      unwrap_used: "warn",
      module_name_repetitions: "allow",
    },
  });
  const w = compareLints(weaker, canon);
  const gapText = w.gaps.join(" | ");
  expect(
    "a canon lint set weaker is a gap and an override",
    gapText.includes("clippy::unwrap_used is warn (canon: deny)") &&
      w.overrides.some((o) => o.name === "unwrap_used" && o.canon === "deny"),
    w,
  );
  expect(
    "a group without priority -1 is a gap",
    gapText.includes("clippy::nursery has priority 0"),
    w.gaps,
  );
  expect(
    "a non-canon lint set to allow is an override, not a gap",
    w.overrides.some((o) => o.name === "module_name_repetitions" && o.canon === undefined) &&
      !gapText.includes("module_name_repetitions"),
    w,
  );
  const missing = compareLints(parse({ clippy: { unwrap_used: "deny" } }), canon);
  expect(
    "missing canon lints are gaps",
    missing.gaps.some((g) => g.includes("clippy::dbg_macro is not set")) &&
      missing.gaps.some((g) => g.includes("unsafe_code is not set")),
    missing.gaps,
  );
  const bad = parseLintTables({ clippy: { x: "loud", y: { priority: 1 } } });
  expect("an unknown level is reported, not dropped", bad.problems.length === 2, bad);
  expect(
    "lintLine finds the key inside its table",
    lintLine(CANON_WS, "workspace.lints", "clippy", "unwrap_used") === 10,
    lintLine(CANON_WS, "workspace.lints", "clippy", "unwrap_used"),
  );
}

function ids(checks: { id: string; status: string }[]): string {
  return checks.map((c) => `${c.id}=${c.status}`).join(" ");
}

const CI_OK =
  "jobs:\n  x:\n    steps:\n      - run: cargo clippy --all-targets -- -D warnings\n      - run: cargo fmt --all --check\n";

function wiring(): void {
  const wired = {
    "Cargo.toml": CANON_WS,
    "crates/a/Cargo.toml": CRATE("a", INHERIT),
    "crates/b/Cargo.toml": CRATE("b", INHERIT),
    "rust-toolchain.toml": '[toolchain]\nchannel = "1.94.1"\n',
  };
  withTree({ ...wired, ".github/workflows/ci.yml": CI_OK }, (d) => {
    const c = rustWiringChecks(d, [".github/workflows/ci.yml"]);
    expect(
      "a wired workspace passes every Rust check",
      c.every((x) => x.status === "pass"),
      c,
    );
  });
  withTree(
    {
      ...wired,
      "Cargo.toml": CANON_WS.replace('unwrap_used = "deny"', 'unwrap_used = "warn"'),
      "crates/b/Cargo.toml": CRATE("b"),
    },
    (d) => {
      const c = rustWiringChecks(d, []);
      expect(
        "a weaker canon lint, a crate without [lints] and no CI each fail",
        ids(c) ===
          "rust.clippy-strict=fail rust.lints-inherited=fail rust.toolchain=pass rust.ci=fail",
        c,
      );
      const strict = c.find((x) => x.id === "rust.clippy-strict");
      expect(
        "the failing check names its evidence",
        strict?.detail.includes("clippy::unwrap_used is warn (canon: deny)") === true,
        strict,
      );
    },
  );
  withTree({ "Cargo.toml": `${CRATE("solo")}\n[lints.clippy]\nunwrap_used = "deny"\n` }, (d) => {
    const c = rustWiringChecks(d, []);
    const strict = c.find((x) => x.id === "rust.clippy-strict");
    expect(
      "a single crate is checked through its own [lints] table",
      strict?.status === "fail" &&
        strict.detail.includes("[lints]") &&
        c.find((x) => x.id === "rust.lints-inherited")?.status === "pass",
      c,
    );
  });
  for (const [name, ci, want] of [
    ["clippy -D warnings without fmt", "run: cargo clippy -- -D warnings\n", "fail"],
    [
      "RUSTFLAGS -D warnings + fmt",
      'env:\n  RUSTFLAGS: "-D warnings"\nrun: cargo clippy --workspace && cargo fmt --check\n',
      "pass",
    ],
    ["guardrails verify", "run: pnpm exec guardrails verify\n", "pass"],
  ] as const) {
    withTree({ ...wired, ".github/workflows/ci.yml": ci }, (d) => {
      const c = rustWiringChecks(d, [".github/workflows/ci.yml"]).find((x) => x.id === "rust.ci");
      expect(`rust.ci: ${name} → ${want}`, c?.status === want, c);
    });
  }
  withTree(
    {
      ...wired,
      ".github/workflows/ci.yml": "run: ./scripts/ci.sh\n",
      "scripts/ci.sh": "cargo clippy --all-targets -- -D warnings\ncargo fmt --check\n",
    },
    (d) => {
      const c = rustWiringChecks(d, [".github/workflows/ci.yml"]).find((x) => x.id === "rust.ci");
      expect("rust.ci follows a script the workflow runs", c?.status === "pass", c);
    },
  );
  withTree({ ...wired, ".github/workflows/ci.yml": CI_OK }, (d) => {
    const w = detectWiring(d);
    expect(
      "a Rust-only repo gets the hook checks and the Rust checks, no TypeScript ones",
      w.checks.map((c) => c.id).join() ===
        "hook-postedit,hook-stop,rust.clippy-strict,rust.lints-inherited,rust.toolchain,rust.ci",
      w.checks,
    );
  });
  withTree({ "package.json": "{}", "src/a.ts": "" }, (d) => {
    const w = detectWiring(d);
    expect(
      "a TypeScript repo keeps exactly the TypeScript checks",
      w.checks.map((c) => c.id).join() ===
        "installed,sgconfig-canon,lint-script,ci,hook-postedit,hook-stop,preset",
      w.checks,
    );
  });
}

detection();
lintTables();
wiring();
if (failed > 0) {
  console.error(`\n${failed} Rust language check(s) failed`);
  process.exit(1);
}
console.log("\nRust language checks passed");
