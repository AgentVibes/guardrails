import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { match } from "ts-pattern";
import { dropGitignored } from "../../fileSloc.js";
import { collectFiles } from "../../fileWalk.js";
import type { Configured, Override, OverrideReason } from "../../overrides.js";
import { type CargoRoot, cargoRoots, type Manifest } from "./cargoManifest.js";
import { canonLints, compareLints, lintLine, lintName, parseLintTables } from "./lintTable.js";
import { closingBracket, lineAt, maskRust, splitArgs, stringValue } from "./rustSource.js";
import { governingLints } from "./rustWiring.js";

// Rust overrides, on the same model as the TypeScript ones (overrides.ts):
//
//   rust-allow — every lint named in `#[allow(...)]`, `#![allow(...)]`,
//                `#[expect(...)]` (and the same inside `#[cfg_attr(…, …)]`)
//                is one override. Its reason is `reason = "…"` in the same
//                attribute.
//   cargo-lint — a canon lint set weaker than the canon, or any lint set to
//                `allow`, in the lint table that governs a crate. Its reason
//                is declared in .agentvibes/project.toml:
//                [[override]] kind = "cargo-lint", rule = "clippy::x",
//                paths = ["Cargo.toml"], reason = "…".
//
// Test code is relaxed narrowly. In a `#[cfg(test)]` or `#[test]` item, a
// `cfg_attr(test, …)`, or a file under `tests/`, `benches/` or `examples/`,
// an allow WITH a reason is not an override (tests may relax a lint when they
// say why); an allow WITHOUT a reason is listed as usual. Unwrap, expect and
// panic in tests need no attribute at all: the shipped clippy.toml allows
// them there.

const TEST_DIRS = new Set(["tests", "benches", "examples"]);

function rel(root: string, path: string): string {
  return relative(root, resolve(root, path)).split(sep).join("/");
}

function reasonOf(text: string | undefined): OverrideReason {
  const t = (text ?? "").trim();
  return t === "" ? { status: "missing" } : { status: "given", text: t };
}

interface Attribute {
  /** Offset of `#`. */
  start: number;
  /** Offset just past `]`. */
  end: number;
  inner: boolean;
  /** Offsets of the attribute's content between `[` and `]`. */
  body: [number, number];
}

function attributes(masked: string): Attribute[] {
  const out: Attribute[] = [];
  const re = /#(!?)\s*\[/g;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = closingBracket(masked, open);
    out.push({ start: m.index, end: close + 1, inner: m[1] === "!", body: [open + 1, close] });
    re.lastIndex = close + 1;
  }
  return out;
}

/** `name(args)` of a meta item: the path and the offsets inside its parentheses. */
function metaCall(
  masked: string,
  from: number,
  to: number,
): { name: string; args: [number, number] } | undefined {
  const text = masked.slice(from, to);
  const m = /^\s*([A-Za-z_][\w:]*)\s*\(/.exec(text);
  if (m === null || m[1] === undefined) return undefined;
  const open = from + m[0].length - 1;
  const close = closingBracket(masked, open);
  return { name: m[1], args: [open + 1, Math.min(close, to)] };
}

function mentionsTest(cond: string): boolean {
  return /\btest\b/.test(cond) && !/\bnot\s*\(/.test(cond);
}

interface Allow {
  lints: string[];
  reason: OverrideReason;
  /** The attribute only applies when compiling tests (`cfg_attr(test, …)`). */
  testOnly: boolean;
}

function allowsIn(
  masked: string,
  original: string,
  from: number,
  to: number,
  testOnly: boolean,
): Allow[] {
  const call = metaCall(masked, from, to);
  if (call === undefined) return [];
  if (call.name === "cfg_attr") {
    const [cond, ...rest] = splitArgs(masked, call.args[0], call.args[1]);
    if (cond === undefined) return [];
    const isTest = testOnly || mentionsTest(masked.slice(cond[0], cond[1]));
    return rest.flatMap(([a, b]) => allowsIn(masked, original, a, b, isTest));
  }
  if (call.name !== "allow" && call.name !== "expect") return [];
  const lints: string[] = [];
  let reason: string | undefined;
  for (const [a, b] of splitArgs(masked, call.args[0], call.args[1])) {
    const piece = masked.slice(a, b).trim();
    const eq = /^reason\s*=/.exec(piece);
    if (eq !== null) {
      const offset = masked.indexOf("=", a) + 1;
      reason = stringValue(original.slice(offset, b));
      continue;
    }
    lints.push(piece.replace(/\s+/g, ""));
  }
  return lints.length === 0 ? [] : [{ lints, reason: reasonOf(reason), testOnly }];
}

/** [start, end) offsets of the item an outer attribute at `attrEnd` applies to. */
function itemRange(masked: string, attrEnd: number): number {
  let depth = 0;
  for (let i = attrEnd; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "#" && depth === 0) {
      // A following attribute on the same item: skip over it.
      const open = masked.indexOf("[", i);
      if (
        open >= 0 &&
        masked
          .slice(i + 1, open)
          .trim()
          .replace("!", "") === ""
      ) {
        i = closingBracket(masked, open);
        continue;
      }
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && ch === ";") return i + 1;
    else if (depth === 0 && ch === "{") return closingBracket(masked, i) + 1;
  }
  return masked.length;
}

/** Offset ranges of test-only code: `#[cfg(test)]` and `#[test]` items, or the whole file. */
function testRanges(masked: string, attrs: readonly Attribute[]): [number, number][] {
  const out: [number, number][] = [];
  for (const a of attrs) {
    const body = masked.slice(a.body[0], a.body[1]).trim();
    const cfgTest = /^cfg\s*\(/.test(body) && mentionsTest(body);
    const testAttr = /^(?:[\w:]+::)?test\s*$/.test(body) || /^(?:[\w:]+::)?test\s*\(/.test(body);
    if (!cfgTest && !testAttr) continue;
    if (a.inner) out.push([0, masked.length]);
    else out.push([a.start, itemRange(masked, a.end)]);
  }
  return out;
}

function inTestDir(relPath: string): boolean {
  return relPath.split("/").some((s) => TEST_DIRS.has(s));
}

/** The rust-allow overrides in one file's text. */
export function rustAllowOverrides(relPath: string, text: string): Override[] {
  if (!text.includes("allow") && !text.includes("expect")) return [];
  const masked = maskRust(text);
  const attrs = attributes(masked);
  const tests = testRanges(masked, attrs);
  const testFile = inTestDir(relPath);
  const out: Override[] = [];
  for (const a of attrs) {
    const inTest = testFile || tests.some(([s, e]) => a.start >= s && a.start < e);
    for (const allow of allowsIn(masked, text, a.body[0], a.body[1], false)) {
      const relaxed = inTest || allow.testOnly;
      // Narrow test relaxation: a test may switch a lint off when it says why.
      if (relaxed && allow.reason.status === "given") continue;
      const line = lineAt(text, a.start);
      for (const rule of allow.lints) {
        out.push({
          kind: "rust-allow",
          rule,
          where: `${relPath}:${line}`,
          file: relPath,
          line,
          reason: allow.reason,
        });
      }
    }
  }
  return out;
}

/** Inline Rust overrides under `targets`; gitignored files (build output) are not the project's. */
export function rustInlineOverrides(root: string, targets: string[]): Override[] {
  const files = dropGitignored(
    collectFiles(
      targets.map((t) => resolve(root, t)),
      [".rs"],
    ),
    root,
  ).filter((f) => !rel(root, f).split("/").includes("target"));
  const out: Override[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // ast-grep-ignore: catch-empty -- a file deleted between the walk and the read has no attributes left to inventory
      continue;
    }
    out.push(...rustAllowOverrides(rel(root, file), text));
  }
  return out;
}

function manifestRel(m: Manifest): string {
  return m.rel === "" ? "Cargo.toml" : `${m.rel}/Cargo.toml`;
}

function tableOverrides(
  m: Manifest,
  prefix: string,
  raw: Record<string, Record<string, unknown>>,
): Configured[] {
  const { tables } = parseLintTables(raw);
  const text = readFileSync(m.path, "utf8");
  const file = manifestRel(m);
  return compareLints(tables, canonLints()).overrides.map((o) => {
    const rule = lintName(o.tool, o.name);
    return {
      kind: "cargo-lint" as const,
      rule,
      where: `${file} [${prefix}.${o.tool}] ${o.name} = "${o.level}"${o.canon === undefined ? "" : ` (canon: ${o.canon})`}`,
      file,
      line: lintLine(text, prefix, o.tool, o.name),
      paths: [file],
    };
  });
}

function rootOverrides(r: CargoRoot): Configured[] {
  const governing = match(governingLints(r))
    .with({ status: "set" }, (l) => tableOverrides(r.manifest, l.prefix, l.raw))
    .with({ status: "absent" }, () => [])
    .exhaustive();
  // A member with its own [lints] instead of inheriting runs its own table.
  const members = r.members.flatMap((m) =>
    match(m.lints)
      .with({ kind: "own" }, (l) => tableOverrides(m, "lints", l.tables))
      .with({ kind: "absent" }, { kind: "inherits" }, () => [])
      .exhaustive(),
  );
  return [...governing, ...members];
}

/** Every cargo-lint override in the checkout, each still without its reason. */
export function cargoLintOverrides(root: string): Configured[] {
  return cargoRoots(root).flatMap(rootOverrides);
}
