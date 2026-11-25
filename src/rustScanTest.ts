import "./testIsolation.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { match } from "ts-pattern";
import { parseClippyJson, parseFmtCheck } from "./lang/rust/clippy.js";
import { dedupeRustFindings } from "./lang/rust/rustFindings.js";
import { rustAllowOverrides } from "./lang/rust/rustOverrides.js";
import { CANON_OVERRIDDEN, collectOverrides, OVERRIDE_WITHOUT_REASON } from "./overrides.js";
import { packageRoot } from "./packagePaths.js";

// The Rust override scanner (rustOverrides.ts) and the clippy / rustfmt
// output parsers (clippy.ts). The parser cases read real cargo output
// captured from a two-crate workspace, with its paths rewritten to /work/ws
// (test/rust/*). No cargo needed.

let failed = 0;
function expect(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}\n  ${JSON.stringify(detail, null, 2)}`);
}

function summary(rows: { rule: string; line: number; reason: { status: string } }[]): string {
  return rows.map((o) => `${o.rule}@${o.line}:${o.reason.status}`).join(" ");
}

function scanner(): void {
  const src = [
    /* 1 */ "#![allow(clippy::module_name_repetitions)]",
    /* 2 */ '#![expect(clippy::cast_possible_truncation, reason = "ids fit in u32")]',
    /* 3 */ "",
    /* 4 */ "#[allow(dead_code, unused_variables)]",
    /* 5 */ "fn a() {}",
    /* 6 */ "// #[allow(clippy::in_a_comment)]",
    /* 7 */ 'const S: &str = "#[allow(clippy::in_a_string)]";',
    /* 8 */ 'const R: &str = r#"#[allow(clippy::in_a_raw_string)]"#;',
    /* 9 */ '#[cfg_attr(feature = "x", allow(clippy::too_many_lines))]',
    /* 10 */ "fn b() {}",
    /* 11 */ "#[warn(clippy::pedantic)]",
    /* 12 */ "fn c() {}",
  ].join("\n");
  const got = rustAllowOverrides("src/lib.rs", src);
  expect(
    "inner and outer allow/expect, one override per lint, with or without reason",
    summary(got) ===
      "clippy::module_name_repetitions@1:missing clippy::cast_possible_truncation@2:given " +
        "dead_code@4:missing unused_variables@4:missing clippy::too_many_lines@9:missing",
    got,
  );
  expect(
    "the reason text is kept",
    got[1] !== undefined &&
      match(got[1].reason)
        .with({ status: "given" }, (r) => r.text === "ids fit in u32")
        .with({ status: "missing" }, () => false)
        .exhaustive(),
    got[1],
  );
  expect("where names file and line", got[0]?.where === "src/lib.rs:1", got[0]);

  const tests = [
    /* 1 */ "fn main() {}",
    /* 2 */ "#[cfg(test)]",
    /* 3 */ "mod tests {",
    /* 4 */ '    #[allow(clippy::float_cmp, reason = "exact fixtures")]',
    /* 5 */ "    fn eq() {}",
    /* 6 */ "    #[allow(clippy::similar_names)]",
    /* 7 */ "    fn names() {}",
    /* 8 */ "}",
    /* 9 */ '#[cfg_attr(test, allow(clippy::large_stack_arrays, reason = "big fixture"))]',
    /* 10 */ "fn d() {}",
    /* 11 */ "#[test]",
    /* 12 */ '#[expect(clippy::unreadable_literal, reason = "a hash")]',
    /* 13 */ "fn t() {}",
    /* 14 */ '#[allow(clippy::float_cmp, reason = "not test code")]',
    /* 15 */ "fn e() {}",
  ].join("\n");
  const t = rustAllowOverrides("src/lib.rs", tests);
  expect(
    "test code: an allow with a reason is not an override; without one, or outside tests, it is",
    summary(t) === "clippy::similar_names@6:missing clippy::float_cmp@14:given",
    t,
  );
  const inTestsDir = rustAllowOverrides(
    "crates/a/tests/it.rs",
    '#[allow(clippy::float_cmp, reason = "fixtures")]\nfn x() {}\n#[allow(clippy::cast_lossless)]\nfn y() {}\n',
  );
  expect(
    "a file under tests/ is test code",
    summary(inTestsDir) === "clippy::cast_lossless@3:missing",
    inTestsDir,
  );
}

function withTree(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-rust-scan-"));
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

function cargoLints(): void {
  const canon = readFileSync(join(packageRoot, "configs", "rust-lints.toml"), "utf8");
  const manifest = `[workspace]\nmembers = ["a"]\n\n${canon.slice(canon.search(/^\[/m))}`
    .replace(/nursery = \{[^}]*\}/, 'nursery = { level = "allow", priority = -1 }')
    .concat('\nmodule_name_repetitions = "allow"\n');
  withTree(
    {
      "Cargo.toml": manifest,
      "a/Cargo.toml":
        '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n\n[lints]\nworkspace = true\n',
      "a/src/lib.rs": '#[expect(clippy::cast_lossless, reason = "widening")]\npub fn f() {}\n',
      ".agentvibes/project.toml":
        '[[override]]\nkind = "cargo-lint"\nrule = "clippy::module_name_repetitions"\npaths = ["Cargo.toml"]\nreason = "crate-prefixed names read better here"\n',
    },
    (d) => {
      const report = collectOverrides(d);
      const rows = report.overrides.map((o) => `${o.kind} ${o.rule} ${o.file} ${o.reason.status}`);
      expect(
        "Cargo.toml: a canon group set to allow and a lint set to allow are cargo-lint overrides",
        rows.includes("cargo-lint clippy::nursery Cargo.toml missing") &&
          rows.includes("cargo-lint clippy::module_name_repetitions Cargo.toml given"),
        rows,
      );
      expect(
        "a .rs expect with a reason is a rust-allow override with its reason",
        rows.includes("rust-allow clippy::cast_lossless a/src/lib.rs given"),
        rows,
      );
      const nursery = report.overrides.find((o) => o.rule === "clippy::nursery");
      expect(
        "the cargo-lint override points at its line in Cargo.toml",
        nursery !== undefined &&
          manifest.split("\n")[nursery.line - 1]?.startsWith("nursery") === true,
        nursery,
      );
      const byRule = (rule: string) => report.findings.filter((f) => f.rule === rule).length;
      expect(
        "one canon-overridden per override, override-without-reason only for the undeclared one",
        byRule(CANON_OVERRIDDEN) === report.overrides.length &&
          byRule(OVERRIDE_WITHOUT_REASON) === 1,
        report.findings,
      );
    },
  );
  withTree({ "package.json": "{}", "src/a.rs": "#[allow(dead_code)]\nfn x() {}\n" }, (d) => {
    const kinds = collectOverrides(d).overrides.map((o) => o.kind);
    expect(
      "a repo without Rust enabled is not scanned for Rust overrides",
      !kinds.includes("rust-allow"),
      kinds,
    );
  });
}

function fixture(name: string): string {
  return readFileSync(join(packageRoot, "test", "rust", name), "utf8");
}

function parsers(): void {
  const lint = parseClippyJson(fixture("clippy-lint.jsonl"), "/work/ws", "/work/ws");
  match(lint)
    .with({ status: "unavailable" }, (r) => expect("clippy-lint.jsonl parses as ran", false, r))
    .with({ status: "ran" }, (r) => {
      const keys = r.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).sort();
      expect(
        "lint findings: absolute paths, duplicates from --all-targets dropped",
        keys.join("|") ===
          [
            "clippy::allow_attributes /work/ws/crates/a/src/lib.rs:12",
            "clippy::allow_attributes_without_reason /work/ws/crates/a/src/lib.rs:12",
            "clippy::cast_sign_loss /work/ws/crates/a/src/lib.rs:21",
            "clippy::lint_groups_priority /work/ws/Cargo.toml:15",
            "clippy::must_use_candidate /work/ws/crates/b/src/lib.rs:1",
            "clippy::unnecessary_literal_unwrap /work/ws/crates/a/src/lib.rs:21",
          ].join("|"),
        keys,
      );
      expect(
        "every lint finding is error tier from clippy",
        r.findings.every((f) => f.severity === "error" && f.source === "clippy"),
        r.findings,
      );
      const msg = (rule: string) => r.findings.find((f) => f.rule === rule)?.message ?? "";
      expect(
        "the original level is kept: deny vs warn denied by -D warnings",
        msg("clippy::allow_attributes").includes("(clippy::allow_attributes is deny)") &&
          msg("clippy::must_use_candidate").includes("is warn, denied by -D warnings"),
        r.findings.map((f) => f.message),
      );
    })
    .exhaustive();
  const outside = parseClippyJson(fixture("clippy-lint.jsonl"), "/work/ws", "/work/ws/crates/b");
  expect(
    "spans outside the repo root are dropped",
    outside.status === "ran" &&
      outside.findings.every((f) => f.file.startsWith("/work/ws/crates/b/")),
    outside,
  );
  const broken = parseClippyJson(fixture("clippy-broken.jsonl"), "/work/ws", "/work/ws");
  expect(
    "a compile error makes the result unavailable with the error, never zero findings",
    broken.status === "unavailable" &&
      broken.reason.includes("E0308") &&
      broken.reason.includes("/work/ws/crates/a/src/lib.rs:26"),
    broken,
  );
  expect(
    "empty output is a run with no findings",
    parseClippyJson("", "/w", "/w").status === "ran",
    null,
  );
  const fmt = parseFmtCheck(fixture("rustfmt-check.txt"));
  expect(
    "rustfmt --check: one finding per run of changed lines, at the original line",
    fmt.map((f) => `${f.file}:${f.line}`).join(" ") ===
      "/work/ws/crates/b/src/lib.rs:2 /work/ws/crates/b/src/lib.rs:5" &&
      fmt.every((f) => f.rule === "rustfmt" && f.source === "rustfmt"),
    fmt,
  );
}

// One crate checked by two [[rust.cargo]] runs (host and wasm32) reports each
// lint once per run; the runs' findings are merged to one per rule, file,
// line, column and message. RED: the concatenation has every finding twice.
function crossRunDedupe(): void {
  const once = parseClippyJson(fixture("clippy-lint.jsonl"), "/work/ws", "/work/ws");
  if (once.status !== "ran") {
    expect("clippy-lint.jsonl parses as ran", false, once);
    return;
  }
  const twice = [...once.findings, ...once.findings];
  const merged = dedupeRustFindings(twice);
  expect(
    "two runs reporting the same lints: each finding once",
    twice.length === 2 * once.findings.length && merged.length === once.findings.length,
    { runs: twice.length, merged: merged.length },
  );
  expect(
    "the merged findings carry no internal column",
    merged.every((f) => !Object.hasOwn(f, "column")),
    merged,
  );
  // The same lint at another column of the same line is another finding,
  // in one run and across runs.
  const line = fixture("clippy-lint.jsonl")
    .split("\n")
    .find((l) => l.includes('"clippy::cast_sign_loss"'));
  if (line === undefined) {
    expect("the fixture has a cast_sign_loss line", false, null);
    return;
  }
  const moved = line.replace(/"column_start":(\d+)/g, (_m, n) => `"column_start":${Number(n) + 7}`);
  const both = parseClippyJson(`${line}\n${moved}\n`, "/work/ws", "/work/ws");
  const atTwoColumns = both.status === "ran" ? both.findings : [];
  expect(
    "one lint at two columns of a line: two findings, kept apart by the dedupe",
    atTwoColumns.length === 2 &&
      dedupeRustFindings([...atTwoColumns, ...atTwoColumns]).length === 2,
    atTwoColumns,
  );
}

scanner();
cargoLints();
parsers();
crossRunDedupe();
if (failed > 0) {
  console.error(`\n${failed} Rust scan check(s) failed`);
  process.exit(1);
}
console.log("\nRust scan checks passed");
