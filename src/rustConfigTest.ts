import "./testIsolation.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { match } from "ts-pattern";
import { detectLanguages } from "./lang/languages.js";
import { cargoRoots } from "./lang/rust/cargoManifest.js";
import { planCargoRuns } from "./lang/rust/cargoPlan.js";
import { parseClippyJson, selectionArgs } from "./lang/rust/clippy.js";
import { rustAllowOverrides } from "./lang/rust/rustOverrides.js";
import { rustWiringChecks } from "./lang/rust/rustWiring.js";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { collectOverrides } from "./overrides.js";
import { packageRoot } from "./packagePaths.js";

// The Rust gaps found rolling guardrails out to Rust repos, each in both
// directions, on small trees in a temp directory. No cargo needed:
//   - `[verify] exclude` keeps vendored Cargo roots and members out;
//   - `reason = "<explanation>"` is no reason;
//   - the canon may live in every member's own [lints];
//   - file-level #![allow]/#![expect] in tests/*.rs are listed;
//   - snapshot records clippy warnings as warnings;
//   - [[rust.cargo]]: per-root target, packages and excluded members.

let failed = 0;
function expect(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}\n  ${JSON.stringify(detail, null, 2)}`);
}

function withTree(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-rust-config-")));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function throwsConfig(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof OverrideConfigError) return err.message;
    throw err;
  }
  return "";
}

const CRATE = (name: string, extra = ""): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`;
const INHERIT = "\n[lints]\nworkspace = true\n";
const CANON = readFileSync(join(packageRoot, "configs", "rust-lints.toml"), "utf8");
/** The canon as a workspace root writes it. */
const CANON_WS = CANON.slice(CANON.search(/^\[/m));
/** The canon as one crate's own `[lints]`. */
const CANON_CRATE = CANON_WS.replaceAll("[workspace.lints.", "[lints.");
const PROJECT = ".agentvibes/project.toml";
const TOOLCHAIN = { "rust-toolchain.toml": '[toolchain]\nchannel = "1.94.1"\n' };

function ids(checks: { id: string; status: string }[]): string {
  return checks.map((c) => `${c.id}=${c.status}`).join(" ");
}

function vendoredRoots(): void {
  const tree = {
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n${CANON_WS}`,
    "crates/a/Cargo.toml": CRATE("a", INHERIT),
    "crates/vend/Cargo.toml": CRATE("vend"),
    "vendor/up/Cargo.toml": `[workspace]\nmembers = ["inner"]\n`,
    "vendor/up/inner/Cargo.toml": CRATE("inner"),
    "vendor/solo/Cargo.toml": CRATE("solo"),
    ...TOOLCHAIN,
  };
  withTree(tree, (d) => {
    const rels = cargoRoots(d).map((r) => r.rel || ".");
    expect(
      "without [verify] exclude, a vendored workspace is a Cargo root",
      rels.join() === ".,vendor/up",
      rels,
    );
  });
  withTree({ ...tree, [PROJECT]: '[verify]\nexclude = "^(vendor/|crates/vend/)"\n' }, (d) => {
    const roots = cargoRoots(d);
    expect(
      "[verify] exclude drops vendored roots; a vendored member is listed apart",
      roots.map((r) => r.rel || ".").join() === "." &&
        roots[0]?.members.map((m) => m.packageName).join() === "a" &&
        roots[0]?.vendored.map((m) => m.packageName).join() === "vend",
      roots.map((r) => ({ rel: r.rel, members: r.members.map((m) => m.rel) })),
    );
    const evidence = detectLanguages(d).find((l) => l.id === "rust")?.evidence ?? "";
    expect(
      "language detection names only the project's Cargo roots",
      evidence === "Cargo.toml at the repo root",
      evidence,
    );
    const c = rustWiringChecks(d, []);
    expect(
      "doctor: a vendored member without [lints] does not fail lints-inherited",
      ids(c).startsWith("rust.clippy-strict=pass rust.lints-inherited=pass"),
      c,
    );
    const plan = planCargoRuns(d, roots);
    const root = roots[0];
    const run = root === undefined ? undefined : plan.get(root);
    expect(
      "clippy runs --workspace --exclude the vendored member",
      run !== undefined &&
        run.runs.map((r) => selectionArgs(r.selection, r.target).join(" ")).join("|") ===
          "--workspace --exclude vend" &&
        run.dropped(join(d, "crates/vend/src/lib.rs")) &&
        run.dropped(join(d, "vendor/solo/src/lib.rs")) &&
        !run.dropped(join(d, "crates/a/src/lib.rs")),
      run,
    );
  });
  withTree({ "Cargo.toml": CRATE("x"), [PROJECT]: '[verify]\nexclude = "("\n' }, (d) => {
    const msg = throwsConfig(() => cargoRoots(d));
    expect(
      "an exclude that is not a regular expression is a config error, not a crash",
      msg.includes("[verify] exclude") && msg.includes("not a regular expression"),
      msg,
    );
  });
}

function placeholderReasons(): void {
  const got = rustAllowOverrides(
    "src/lib.rs",
    '#[allow(clippy::a, reason = "<explanation>")]\nfn x() {}\n#[expect(clippy::b, reason = "<why>")]\nfn y() {}\n#[allow(clippy::c, reason = "real")]\nfn z() {}\n',
  );
  expect(
    'reason = "<explanation>" (or "<why>") is no reason; a real one is',
    got.map((o) => `${o.rule}:${o.reason.status}`).join(" ") ===
      "clippy::a:missing clippy::b:missing clippy::c:given",
    got,
  );
  const inTests = rustAllowOverrides(
    "tests/it.rs",
    '#[allow(clippy::float_cmp, reason = "<explanation>")]\nfn x() {}\n',
  );
  expect(
    "in test code a placeholder reason is missing, so the allow is listed",
    inTests.map((o) => `${o.rule}:${o.reason.status}`).join() === "clippy::float_cmp:missing",
    inTests,
  );
  withTree(
    {
      "Cargo.toml": CRATE("a"),
      "src/lib.rs": '#[allow(dead_code, reason = "<explanation>")]\nfn x() {}\n',
    },
    (d) => {
      const r = collectOverrides(d);
      expect(
        "the placeholder gets an override-without-reason warning",
        r.findings.some(
          (f) => f.rule === "override-without-reason" && f.message.includes("dead_code"),
        ),
        r.findings,
      );
    },
  );
}

function fileLevelTestAttributes(): void {
  const got = rustAllowOverrides(
    "crates/a/tests/it.rs",
    [
      "#![allow(clippy::unwrap_used)]",
      '#![expect(clippy::float_cmp, reason = "exact fixtures")]',
      "",
      "mod inner {",
      '    #![allow(clippy::similar_names, reason = "names from the spec")]',
      "}",
      '#[allow(clippy::cast_lossless, reason = "fixture")]',
      "fn x() {}",
    ].join("\n"),
  );
  expect(
    "tests/*.rs: file-level #![allow]/#![expect] are listed, with or without reason; narrower ones keep the test relaxation",
    got.map((o) => `${o.rule}@${o.line}:${o.reason.status}`).join(" ") ===
      "clippy::unwrap_used@1:missing clippy::float_cmp@2:given",
    got,
  );
  const src = rustAllowOverrides(
    "src/lib.rs",
    '#[cfg(test)]\nmod tests {\n    #![allow(clippy::float_cmp, reason = "fixtures")]\n}\n',
  );
  expect("an inner allow inside a #[cfg(test)] module is still test code", src.length === 0, src);
}

function perMemberCanon(): void {
  const members = {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "crates/a/Cargo.toml": CRATE("a", `\n${CANON_CRATE}`),
    "crates/b/Cargo.toml": CRATE("b", `\n${CANON_CRATE}`),
    ...TOOLCHAIN,
  };
  withTree(members, (d) => {
    const c = rustWiringChecks(d, []);
    const strict = c.find((x) => x.id === "rust.clippy-strict");
    expect(
      "the canon in every member's own [lints] passes clippy-strict and lints-inherited",
      ids(c).startsWith("rust.clippy-strict=pass rust.lints-inherited=pass") &&
        strict?.detail.includes("every checked crate's own [lints] meets the canon") === true,
      c,
    );
  });
  withTree({ ...members, "crates/b/Cargo.toml": CRATE("b") }, (d) => {
    const c = rustWiringChecks(d, []);
    expect(
      "one member without the canon fails clippy-strict",
      ids(c).startsWith("rust.clippy-strict=fail rust.lints-inherited=fail"),
      c,
    );
  });
  withTree(
    {
      ...members,
      "crates/b/Cargo.toml": CRATE(
        "b",
        `\n${CANON_CRATE.replace('unwrap_used = "deny"', 'unwrap_used = "warn"')}`,
      ),
    },
    (d) => {
      const c = rustWiringChecks(d, []);
      expect(
        "one member weaker than the canon fails clippy-strict",
        ids(c).startsWith("rust.clippy-strict=fail"),
        c,
      );
    },
  );
  withTree(
    {
      ...members,
      "crates/b/Cargo.toml": CRATE("b"),
      [PROJECT]: '[[rust.cargo]]\nroot = "."\nexclude_packages = ["b"]\n',
    },
    (d) => {
      const c = rustWiringChecks(d, []);
      expect(
        "a member left out of every [[rust.cargo]] run does not count",
        ids(c).startsWith("rust.clippy-strict=pass"),
        c,
      );
    },
  );
}

function snapshotSeverity(): void {
  const text = readFileSync(join(packageRoot, "test", "rust", "clippy-lint.jsonl"), "utf8");
  const r = parseClippyJson(text, "/work/ws", "/work/ws", "clippy-level");
  match(r)
    .with({ status: "unavailable" }, (u) => expect("clippy-lint.jsonl parses", false, u))
    .with({ status: "ran" }, (ran) => {
      const sev = (rule: string) => ran.findings.find((f) => f.rule === rule)?.severity;
      expect(
        "clippy-level: a warn lint is a warning, a deny lint an error",
        sev("clippy::must_use_candidate") === "warning" &&
          sev("clippy::allow_attributes") === "error",
        ran.findings.map((f) => `${f.rule}:${f.severity}`),
      );
      expect(
        "clippy-level messages do not claim -D warnings",
        ran.findings.every((f) => !f.message.includes("denied by -D warnings")),
        ran.findings.map((f) => f.message),
      );
    })
    .exhaustive();
}

function cargoRunsConfig(): void {
  const ws = {
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n${CANON_WS}`,
    "crates/core/Cargo.toml": CRATE("core", INHERIT),
    "crates/web/Cargo.toml": CRATE("web", INHERIT),
    "crates/gen/Cargo.toml": CRATE("gen", INHERIT),
  };
  const config = [
    "[[rust.cargo]]",
    'root = "."',
    'exclude_packages = ["web", "gen"]',
    "",
    "[[rust.cargo]]",
    'root = "."',
    'target = "wasm32-unknown-unknown"',
    'packages = ["web"]',
    "",
  ].join("\n");
  withTree({ ...ws, [PROJECT]: config }, (d) => {
    const roots = cargoRoots(d);
    const root = roots[0];
    const plan = root === undefined ? undefined : planCargoRuns(d, roots).get(root);
    expect(
      "[[rust.cargo]]: one clippy run per entry, with its selection and target",
      plan?.configured === true &&
        plan.runs.map((r) => selectionArgs(r.selection, r.target).join(" ")).join("|") ===
          "--workspace --exclude web --exclude gen|-p web --target wasm32-unknown-unknown",
      plan?.runs,
    );
    expect(
      "a member no run checks is unchecked, and its files are dropped",
      plan !== undefined &&
        plan.unchecked.map((m) => m.packageName).join() === "gen" &&
        plan.dropped(join(d, "crates/gen/src/lib.rs")) &&
        !plan.dropped(join(d, "crates/web/src/lib.rs")),
      plan?.unchecked.map((m) => m.rel),
    );
    const r = collectOverrides(d);
    const left = r.overrides.filter((o) => o.rule === "rust.cargo");
    expect(
      "the left-out member is a verify-scope override that needs a reason",
      left.length === 1 &&
        left[0]?.kind === "verify-scope" &&
        left[0]?.where.includes("leaves out gen") &&
        r.findings.some(
          (f) => f.rule === "override-without-reason" && f.message.includes("rust.cargo"),
        ),
      left,
    );
  });
  withTree(
    {
      ...ws,
      [PROJECT]: `${config}[[override]]\nkind = "verify-scope"\nrule = "rust.cargo"\nreason = "gen is built from a schema at build time"\n`,
    },
    (d) => {
      const r = collectOverrides(d);
      expect(
        "an [[override]] verify-scope rust.cargo gives the left-out member its reason",
        r.overrides.some((o) => o.rule === "rust.cargo" && o.reason.status === "given") &&
          !r.findings.some((f) => f.rule === "override-without-reason"),
        r.findings,
      );
    },
  );
  withTree({ ...ws }, (d) => {
    const roots = cargoRoots(d);
    const root = roots[0];
    const plan = root === undefined ? undefined : planCargoRuns(d, roots).get(root);
    expect(
      "no [[rust.cargo]]: one host --workspace run, nothing unchecked",
      plan !== undefined &&
        !plan.configured &&
        plan.unchecked.length === 0 &&
        plan.runs.map((r) => selectionArgs(r.selection, r.target).join(" ")).join("|") ===
          "--workspace",
      plan,
    );
  });
  const bad: [string, string, string][] = [
    ["unknown root", '[[rust.cargo]]\nroot = "nope"\n', "is not a Cargo root"],
    [
      "unknown package",
      '[[rust.cargo]]\nroot = "."\nexclude_packages = ["typo"]\n',
      "names typo, not a package",
    ],
    [
      "packages and exclude_packages together",
      '[[rust.cargo]]\npackages = ["web"]\nexclude_packages = ["gen"]\n',
      "sets both packages and exclude_packages",
    ],
    ["an unknown key", '[[rust.cargo]]\ntarghet = "x"\n', "[[rust.cargo]]"],
  ];
  for (const [name, body, want] of bad) {
    withTree({ ...ws, [PROJECT]: body }, (d) => {
      const msg = throwsConfig(() => planCargoRuns(d, cargoRoots(d)));
      expect(`[[rust.cargo]] ${name} is a config error`, msg.includes(want), msg);
    });
  }
}

vendoredRoots();
placeholderReasons();
fileLevelTestAttributes();
perMemberCanon();
snapshotSeverity();
cargoRunsConfig();
if (failed > 0) {
  console.error(`\n${failed} Rust config check(s) failed`);
  process.exit(1);
}
console.log("\nRust config checks passed");
