import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { match } from "ts-pattern";
import { dropGitignored } from "./fileSloc.js";
import { DEFAULT_MAX_FILE_SLOC } from "./fileSlocBaseline.js";
import { collectFiles } from "./fileWalk.js";
import type { Finding } from "./findings.js";
import { hasLanguage, resolveLanguages } from "./lang/languages.js";
import {
  cargoLintOverrides,
  cargoRunOverrides,
  rustInlineOverrides,
} from "./lang/rust/rustOverrides.js";
import {
  isPlaceholderReason,
  type OverrideDeclaration,
  readOverrideDeclarations,
  samePaths,
} from "./overrideDeclarations.js";
import { packageRoot, ruleFixtureFilter, rulesDir } from "./packagePaths.js";
import { readBiomeRoot } from "./presetDrift.js";
import { declaredRuleDirs, repoRuleConfig } from "./repoRules.js";
import { SCOPES } from "./screenScope.js";
import { readTomlTable } from "./tomlTable.js";

// The overrides inventory: every way a repo deviates from the canon, and the
// written reason for each. A deviation is legitimate when someone wrote down
// why; one without a reason is a WARNING finding, `override-without-reason`.
// Warnings never change an exit code, so this makes deviations visible without
// turning any repo red the day it upgrades.
//
// Every override, reasoned or not, is also a `canon-overridden` warning: a
// written reason makes a deviation legitimate, not invisible. A repo that is
// wired but overrides anything is PARTIALLY wired, never fully (wiring state
// `partial`, not `on`).
//
// Where the reason lives:
//   - inline suppressions (`// ast-grep-ignore: <id> -- <why>`, the JSX form
//     `{/* ast-grep-ignore: <id> -- <why> */}`, `// biome-ignore <rule>: <why>`)
//     carry it in the comment;
//   - everything configured (verify scopes, biome rule overrides, repo rules
//     reusing a canon id, a raised file-length limit) is declared in
//     .agentvibes/project.toml as `[[override]] kind/rule/paths/reason`
//     (overrideDeclarations.ts).
//
// Not overrides: a `[severity]` RAISE makes the gate stricter, and a lowering
// is already refused by severity.ts. A lower `max_file_sloc` is also stricter.

/** One per override, reason or not: the repo runs a weaker gate than the canon here. */
export const CANON_OVERRIDDEN = "canon-overridden";
export const OVERRIDE_WITHOUT_REASON = "override-without-reason";
export const OVERRIDE_DECLARED_UNUSED = "override-declared-unused";

export type OverrideKind =
  | "ast-grep-ignore"
  | "biome-ignore"
  | "verify-scope"
  | "biome-rule"
  | "repo-rule-shadow"
  | "metrics-limit"
  | "rust-allow"
  | "cargo-lint";

export type OverrideReason = { status: "given"; text: string } | { status: "missing" };

export interface Override {
  kind: OverrideKind;
  /** The rule (or scope key, or limit key) the override touches; "*" = every rule. */
  rule: string;
  /** Human location: `src/a.ts:12`, `biome.json overrides[0] (src/**)`, `[verify] screens`. */
  where: string;
  /** Repo-relative file the override is written in. */
  file: string;
  /** 1-based line for inline suppressions; 0 for config entries, which are not line-addressed. */
  line: number;
  reason: OverrideReason;
}

export interface OverrideReport {
  overrides: Override[];
  /** `canon-overridden` (one per override), `override-without-reason`, `override-declared-unused`; all warning tier. */
  findings: Finding[];
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Comment opener at the start of a line: `//`, `/*`, or JSX `{/*`. */
const OPENER = String.raw`^\s*(?:\/\/|\/\*|\{\s*\/\*)\s*`;
/** Closer of a block / JSX comment, if any. */
const CLOSER = String.raw`\s*(?:\*\/\s*\}?)?\s*$`;

/**
 * `ast-grep-ignore` with no ids (suppresses every rule), or `: id[, id] [-- why]`.
 * Only directives that START a line are read: a trailing `code // ast-grep-ignore`
 * is not inventoried, because telling it apart from the same text inside a
 * string needs a parser this scan does not run.
 */
const AST_GREP_IGNORE = new RegExp(
  `${OPENER}ast-grep-ignore(?:\\s*:\\s*([A-Za-z0-9_,\\s-]*?))?(?:\\s+--\\s*(.*?))?${CLOSER}`,
);
/** `biome-ignore[-all|-start] <category>[: <why>]`. */
const BIOME_IGNORE = new RegExp(
  `${OPENER}biome-ignore(?:-all|-start)?\\s+([^:\\s]+)\\s*(?::\\s*(.*?))?${CLOSER}`,
);

function reasonOf(text: string | undefined): OverrideReason {
  const t = (text ?? "").trim();
  // A placeholder (biome's `<explanation>`, our `<why>`) is not a reason.
  if (t === "" || isPlaceholderReason(t)) return { status: "missing" };
  return { status: "given", text: t };
}

function rel(root: string, path: string): string {
  return relative(root, resolve(root, path)).split(sep).join("/");
}

function inlineOverrides(root: string, targets: string[]): Override[] {
  const out: Override[] = [];
  // In this package's own source, a suppression in a rule fixture proves the
  // suppression works (`good.ts` stays clean BECAUSE of it); it is not a place
  // where the repo weakens the canon.
  const isRuleFixture = ruleFixtureFilter(root);
  // Gitignored files (generated code, local build output) are not the
  // project's source, so a suppression in them is not the project's override.
  const files = dropGitignored(
    collectFiles(
      targets.map((t) => resolve(root, t)),
      SOURCE_EXTS,
    ),
    root,
  ).filter((f) => !isRuleFixture(f));
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // ast-grep-ignore: catch-empty -- a file deleted between the walk and the read has no suppressions left to inventory
      continue;
    }
    if (!text.includes("ast-grep-ignore") && !text.includes("biome-ignore")) continue;
    const relPath = rel(root, file);
    text.split("\n").forEach((lineText, i) => {
      const line = i + 1;
      const where = `${relPath}:${line}`;
      const ag = AST_GREP_IGNORE.exec(lineText);
      if (ag !== null) {
        const ids = (ag[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        const reason = reasonOf(ag[2]);
        for (const rule of ids.length === 0 ? ["*"] : ids) {
          out.push({ kind: "ast-grep-ignore", rule, where, file: relPath, line, reason });
        }
        return;
      }
      const bi = BIOME_IGNORE.exec(lineText);
      if (bi?.[1] !== undefined) {
        out.push({
          kind: "biome-ignore",
          rule: bi[1].replace(/^lint\//, ""),
          where,
          file: relPath,
          line,
          reason: reasonOf(bi[2]),
        });
      }
    });
  }
  return out;
}

/** Every configured deviation, each still without its reason (filled from declarations). */
export type Configured = Omit<Override, "reason"> & { paths: string[] };

function verifyScopes(root: string): Configured[] {
  const table = readTomlTable(join(root, ".agentvibes", "project.toml"), "verify");
  const keys = [...SCOPES.map((s) => s.tomlKey), "exclude"];
  return keys
    .filter((k) => table[k] !== undefined)
    .map((k) => ({
      kind: "verify-scope" as const,
      rule: k,
      where: `[verify] ${k} = "${table[k]}"`,
      file: ".agentvibes/project.toml",
      line: 0,
      paths: [],
    }));
}

function rulesIn(linter: unknown): string[] {
  const rules = (linter as { rules?: unknown } | undefined)?.rules;
  // ast-grep-ignore: silent-default-return -- a linter block without a rules object turns no rule off
  if (typeof rules !== "object" || rules === null) return [];
  const out: string[] = [];
  for (const [group, body] of Object.entries(rules)) {
    if (typeof body !== "object" || body === null) continue;
    for (const rule of Object.keys(body)) out.push(`${group}/${rule}`);
  }
  return out;
}

function biomeRules(root: string): Configured[] {
  const config = readBiomeRoot(root);
  if (config === undefined) return [];
  const out: Configured[] = [];
  for (const rule of rulesIn(config.linter)) {
    out.push({
      kind: "biome-rule",
      rule,
      where: `biome.json linter.rules ${rule} (whole repo)`,
      file: "biome.json",
      line: 0,
      paths: [],
    });
  }
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];
  overrides.forEach((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null) return;
    const o = entry as Record<string, unknown>;
    const raw = o.includes ?? o.files;
    const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
    for (const rule of rulesIn(o.linter)) {
      out.push({
        kind: "biome-rule",
        rule,
        where: `biome.json overrides[${i}] ${rule} (${paths.join(", ")})`,
        file: "biome.json",
        line: 0,
        paths,
      });
    }
  });
  return out;
}

function ruleIdsIn(dir: string): Map<string, string> {
  const ids = new Map<string, string>();
  if (!existsSync(dir)) return ids;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    const id = readFileSync(join(dir, f), "utf8").match(/^id:\s*(\S+)/m)?.[1];
    if (id !== undefined) ids.set(id, join(dir, f));
  }
  return ids;
}

/** A repo rule that reuses a canon id replaces the canon's definition of it in the repo's scans. */
function ruleShadows(root: string): Configured[] {
  const config = repoRuleConfig(root);
  // ast-grep-ignore: silent-default-return -- no repo sgconfig.yml means no repo rules, so nothing can shadow the canon
  if (config === undefined) return [];
  const canon = ruleIdsIn(rulesDir);
  const pkg = resolve(packageRoot);
  const out: Configured[] = [];
  for (const dir of declaredRuleDirs(config)) {
    const abs = resolve(root, dir);
    // The canon dir itself, through node_modules or a sibling checkout.
    if (abs === resolve(rulesDir) || abs.startsWith(pkg + sep) || /node_modules/.test(dir))
      continue;
    for (const [id, path] of ruleIdsIn(abs)) {
      if (!canon.has(id)) continue;
      out.push({
        kind: "repo-rule-shadow",
        rule: id,
        where: `${rel(root, path)} redefines canon rule ${id}`,
        file: rel(root, path),
        line: 0,
        paths: [],
      });
    }
  }
  return out;
}

function metricsLimits(root: string): Configured[] {
  const raw = readTomlTable(join(root, ".agentvibes", "project.toml"), "metrics").max_file_sloc;
  // ast-grep-ignore: silent-default-return -- no key or a limit at/below the default is not a deviation; a malformed value is reported by maxFileSloc
  if (raw === undefined || !/^\d+$/.test(raw.trim()) || Number(raw) <= DEFAULT_MAX_FILE_SLOC)
    return [];
  return [
    {
      kind: "metrics-limit",
      rule: "max_file_sloc",
      where: `[metrics] max_file_sloc = ${raw.trim()} (default ${DEFAULT_MAX_FILE_SLOC})`,
      file: ".agentvibes/project.toml",
      line: 0,
      paths: [],
    },
  ];
}

function declarationFor(
  c: Configured,
  declarations: readonly OverrideDeclaration[],
): OverrideDeclaration | undefined {
  return declarations.find(
    (d) =>
      d.kind === c.kind &&
      d.rule === c.rule &&
      match(d)
        .with({ kind: "biome-rule" }, { kind: "cargo-lint" }, (b) => samePaths(b.paths, c.paths))
        .with(
          { kind: "verify-scope" },
          { kind: "repo-rule-shadow" },
          { kind: "metrics-limit" },
          () => true,
        )
        .exhaustive(),
  );
}

function warning(rule: string, o: { file: string; line: number }, message: string): Finding {
  return { rule, severity: "warning", file: o.file, line: o.line, message, source: "override" };
}

/**
 * Every override in `root`, with its reason or the lack of one. `targets`
 * limits the inline-suppression scan (config overrides are repo-wide).
 * Throws OverrideConfigError when `[[override]]` cannot be read.
 */
export function collectOverrides(root: string, targets: string[] = ["."]): OverrideReport {
  const declarations = readOverrideDeclarations(root);
  const used = new Set<number>();
  // Rust overrides only where Rust is enabled: a TypeScript-only repo scans
  // exactly what it always did.
  const rust = hasLanguage(resolveLanguages(root).languages, "rust");
  const configured = [
    ...verifyScopes(root),
    ...biomeRules(root),
    ...ruleShadows(root),
    ...metricsLimits(root),
    ...(rust ? cargoLintOverrides(root) : []),
    ...(rust ? cargoRunOverrides(root) : []),
  ];
  const overrides: Override[] = [
    ...configured.map((c) => {
      const d = declarationFor(c, declarations);
      if (d !== undefined) used.add(d.index);
      const { paths: _paths, ...rest } = c;
      return { ...rest, reason: reasonOf(d?.reason) };
    }),
    ...inlineOverrides(root, targets),
    ...(rust ? rustInlineOverrides(root, targets) : []),
  ];
  const overridden: Finding[] = overrides.map((o) =>
    warning(
      CANON_OVERRIDDEN,
      o,
      `${o.where}: ${o.kind} ${o.rule} overrides the canon — ${match(o.reason)
        .with({ status: "given" }, (r) => `reason: ${r.text}`)
        .with({ status: "missing" }, () => "no reason given")
        .exhaustive()}`,
    ),
  );
  const findings: Finding[] = overrides
    .filter((o) => o.reason.status === "missing")
    .map((o) =>
      warning(
        OVERRIDE_WITHOUT_REASON,
        o,
        match(o.kind)
          .with(
            "ast-grep-ignore",
            () =>
              `${o.where}: ast-grep-ignore ${o.rule} has no reason — write \`-- <why>\` after the rule id`,
          )
          .with(
            "biome-ignore",
            () =>
              `${o.where}: biome-ignore ${o.rule} has no reason — write \`: <why>\` after the rule`,
          )
          .with(
            "rust-allow",
            () =>
              `${o.where}: allow/expect ${o.rule} has no reason — write \`reason = "<why>"\` in the attribute`,
          )
          .with(
            "verify-scope",
            "biome-rule",
            "cargo-lint",
            "repo-rule-shadow",
            "metrics-limit",
            (kind) =>
              `${o.where}: no reason — declare it in .agentvibes/project.toml: [[override]] kind = "${kind}", rule = "${o.rule}"${kind === "biome-rule" || kind === "cargo-lint" ? `, paths = ${JSON.stringify(configured.find((c) => c.where === o.where)?.paths ?? [])}` : ""}, reason = "<why>"`,
          )
          .exhaustive(),
      ),
    );
  for (const d of declarations) {
    if (used.has(d.index)) continue;
    findings.push(
      warning(
        OVERRIDE_DECLARED_UNUSED,
        { file: ".agentvibes/project.toml", line: 0 },
        `[[override]] #${d.index + 1} (${d.kind} ${d.rule}) matches nothing in the repo — delete it, or fix its rule/paths`,
      ),
    );
  }
  return { overrides, findings: [...overridden, ...findings] };
}
