import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  findBiomeDeclaration,
  OverrideConfigError,
  type OverrideDeclaration,
  readOverrideDeclarations,
} from "./overrideDeclarations.js";
import { packageRoot } from "./packagePaths.js";

// Preset-drift guard. Consumers moved from 37 hand-rolled biome configs to
// one preset, and nothing stopped a repo from re-growing its own the week
// after. One preset everywhere is the rule, so the tool is the enforcement,
// not the convention.
//
// Three ways a repo drifts:
//   a. its `biome.json` does not extend `@agentvibes/guardrails/biome`,
//   b. it extends the preset and then restates the preset's own decisions —
//      a top-level `formatter`, `javascript.formatter`, `json.formatter`,
//      `linter` or `assist` key,
//   c. a second `biome.json` / `biome.jsonc` sits somewhere in the tree.
//
// What stays legal, because it is scoping rather than style: `files` (a repo
// decides which of ITS paths are linted) and an `overrides` entry that only
// turns `noConsole` off for some paths (a CLI has to print), or
// `noEmptyBlockStatements` off for TEST paths (see OVERRIDABLE).
//
// Drift GATES in every repo: `verify` exits 2 and `doctor` exits 1, as the
// design requires. Up to 0.2.4 it gated only where a repo
// had opted in with `[biome] preset = "enforced"`; that line is now inert, and
// a repo that has not migrated goes red the day it upgrades guardrails.
//
// DECLARED ESCAPES. Any other rule a repo turns off or reconfigures is drift
// unless the repo declares it with a reason in .agentvibes/project.toml:
//
//   [[override]]
//   kind   = "biome-rule"
//   rule   = "suspicious/noUndeclaredEnvVars"
//   paths  = ["**/scripts/**"]          # the override entry's includes, exactly
//   reason = "<why>"
//
// The declaration must name the same rule and the same path set as the
// override entry (no paths = the repo-wide `linter.rules`), and its reason must
// not be empty. A top-level `linter` is then allowed only when it holds nothing
// but declared `rules`. `extends`, the formatter keys, `assist` and a second
// config stay hard failures: those are a fork of the preset, not a rule escape.
//
// A repo with no biome config at all is not drifting and reports nothing —
// there is no config to have re-grown. `guardrails doctor` still shows it as
// absent, and `guardrails init` writes one.

/** The package specifier a consuming repo must extend. */
export const PRESET_SPECIFIER = "@agentvibes/guardrails/biome";

/** Top-level keys the preset owns; a repo restating them has forked it. */
const PRESET_OWNED = ["formatter", "linter", "assist"] as const;

/** Nested `<section>.formatter` keys the preset owns. */
const PRESET_OWNED_NESTED = ["javascript", "json"] as const;

/** Keys an override may carry besides its rule content — path scoping only. */
const OVERRIDE_SCOPING = new Set(["includes", "files", "ignore"]);

/**
 * The only rules a repo may override, and why each is not a fork of the preset.
 *
 * `noConsole` — a CLI has to print.
 *
 * `noEmptyBlockStatements` — error-tier in the preset, and it fires on
 * `mockImplementation(() => {})` and friends. Measured while migrating
 * consumers to the preset: 110 occurrences in one app, almost all in
 * `__tests__/`, and 16 in @agentvibes/kit. Writing a suppression comment on
 * every one of them is noise, not review. The answer: a per-repo
 * override, scoped to tests. It stays error-tier in real source, which is where
 * an empty `catch` actually hides something.
 */
const OVERRIDABLE = new Set(["noConsole", "noEmptyBlockStatements"]);

/** A path glob that names test code — the only scope the empty-block carve-out may take. */
const TEST_PATH =
  /(^|\/|\*)(__tests__|__e2e__|__mocks__|tests?|e2e|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|\.(test|spec)\.\*|\*\.(test|spec)\b/;

/**
 * True when EVERY positive glob in the entry's `includes` names test code. An
 * entry with no `includes`, or with one non-test glob among them, is not
 * test-scoped: the carve-out would then reach production files.
 */
/** An override entry's path globs (`includes`, or the older `files`). */
function includesOf(entry: Record<string, unknown>): string[] {
  const raw = entry.includes ?? entry.files;
  return Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string") : [];
}

function testScoped(entry: Record<string, unknown>): boolean {
  const positive = includesOf(entry).filter((g) => !g.startsWith("!"));
  return positive.length > 0 && positive.every((g) => TEST_PATH.test(g));
}

export interface DriftFinding {
  /** What is wrong, keyed for the one-line message. */
  key: string;
  detail: string;
}

interface BiomeConfig {
  extends?: unknown;
  overrides?: unknown;
  [k: string]: unknown;
}

// Only node_modules: a dependency's own biome.json is not this repo's config.
// Every other directory is walked, build output and dot-directories included —
// a config under dist/, .claude/ or .next/ is still a second config, and the
// acceptance criterion names node_modules as the one exception.
// Consequence: an agent worktree kept inside the repo (`.claude/worktrees/<n>/`)
// carries its own biome.json and is reported locally; CI checkouts have none.
const SKIP_DIRS = new Set(["node_modules"]);

/** Every biome config in the tree, repo-root-relative, excluding node_modules. */
export function findBiomeConfigs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(path);
        continue;
      }
      if (st.isFile() && (entry === "biome.json" || entry === "biome.jsonc")) {
        out.push(relative(root, path));
      }
    }
  };
  visit(root);
  return out.sort();
}

/** The root biome.json, parsed; undefined when absent or unreadable. */
export function readBiomeRoot(root: string): BiomeConfig | undefined {
  const path = join(root, "biome.json");
  return existsSync(path) ? readConfig(path) : undefined;
}

/** True when the repo declared this rule at exactly these paths, with a non-empty reason. */
function declaredEscape(
  declarations: readonly OverrideDeclaration[],
  rule: string,
  paths: readonly string[],
): boolean {
  const d = findBiomeDeclaration(declarations, rule, paths);
  return d !== undefined && d.reason.trim() !== "";
}

function readConfig(path: string): BiomeConfig | undefined {
  try {
    // biome.jsonc allows comments; strip line comments before parsing rather
    // than adding a JSONC dependency for a check that only reads a few keys.
    const raw = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as BiomeConfig) : undefined;
  } catch {
    return undefined;
  }
}

function extendsList(config: BiomeConfig): string[] {
  const e = config.extends;
  if (typeof e === "string") return [e];
  if (Array.isArray(e)) return e.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * True when this repo IS the package that publishes the preset. Its root config
 * extends `./configs/biome.json` by path (the specifier would resolve through
 * node_modules to itself), and `configs/biome.json` is the preset SOURCE, not a
 * competing config — so both are exempt from (a) and (c).
 */
function isPresetSource(root: string): boolean {
  return resolve(root) === resolve(packageRoot);
}

/** Overrides that do more than turn `noConsole` off for some paths. */
function offendingOverrides(
  config: BiomeConfig,
  declarations: readonly OverrideDeclaration[],
): string[] {
  const overrides = config.overrides;
  // ast-grep-ignore: silent-default-return -- "no overrides key" and "overrides is not a list" both mean the config has no override to object to; [] is the real answer, not a swallowed failure
  if (!Array.isArray(overrides)) return [];
  const bad: string[] = [];
  overrides.forEach((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null) return;
    const o = entry as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (OVERRIDE_SCOPING.has(key)) continue;
      if (key !== "linter") {
        bad.push(`overrides[${i}].${key}`);
        continue;
      }
      // A linter override may carry only `rules`. Each rule must be either one
      // of the two carve-outs (OVERRIDABLE, both under `suspicious`) or a
      // declared escape at exactly this entry's paths.
      const linter = o.linter;
      const linterKeys = typeof linter === "object" && linter !== null ? Object.keys(linter) : [];
      const rules = (linter as Record<string, unknown> | undefined)?.rules;
      const groups =
        typeof rules === "object" && rules !== null ? (rules as Record<string, unknown>) : {};
      const paths = includesOf(o);
      const named: Array<{ group: string; rule: string }> = [];
      for (const [group, body] of Object.entries(groups)) {
        const ruleNames = typeof body === "object" && body !== null ? Object.keys(body) : [];
        for (const rule of ruleNames) named.push({ group, rule });
      }
      const undeclared = named.filter(
        (r) => !declaredEscape(declarations, `${r.group}/${r.rule}`, paths),
      );
      const allowed = undeclared.every((r) => r.group === "suspicious" && OVERRIDABLE.has(r.rule));
      if (named.length === 0 || linterKeys.some((k) => k !== "rules") || !allowed) {
        bad.push(
          `overrides[${i}].linter.rules (only ${[...OVERRIDABLE].map((r) => `suspicious.${r}`).join(" and ")} may be overridden without a declaration; declare any other rule as [[override]] kind = "biome-rule" with these exact paths and a reason)`,
        );
        continue;
      }
      // The empty-block carve-out is for TEST code only. Unscoped, it would be
      // the whole rule switched off through a loophole — unless declared.
      if (undeclared.some((r) => r.rule === "noEmptyBlockStatements") && !testScoped(o)) {
        bad.push(
          `overrides[${i}].linter.rules.suspicious.noEmptyBlockStatements (allowed only for test paths — every entry in \`includes\` must name a test file or directory)`,
        );
      }
    }
  });
  return bad;
}

/**
 * Everything wrong with `root`'s biome configuration; [] when it conforms.
 * `root` is the repo being checked, not this package.
 */
export function presetDrift(root: string): DriftFinding[] {
  const configs = findBiomeConfigs(root);
  if (configs.length === 0) return [];

  const findings: DriftFinding[] = [];
  const source = isPresetSource(root);
  // A declaration file the gate cannot read is itself drift: silently treating
  // it as "nothing declared" would turn every declared escape into a failure
  // with the wrong reason, and treating it as "everything declared" is worse.
  let declarations: OverrideDeclaration[] = [];
  try {
    declarations = readOverrideDeclarations(root);
  } catch (err) {
    if (!(err instanceof OverrideConfigError)) throw err;
    findings.push({ key: "override-config", detail: err.message });
  }

  // (c) One config, at the root. The preset source itself carries a second one
  // — `configs/biome.json` IS the preset — and that is not drift.
  const extras = configs.filter(
    (c) => c !== "biome.json" && !(source && c === join("configs", "biome.json")),
  );
  if (extras.length > 0) {
    findings.push({
      key: "extra-config",
      detail: `${extras.length} biome config(s) besides the root one: ${extras.join(", ")}`,
    });
  }

  const rootPath = join(root, "biome.json");
  if (!existsSync(rootPath)) {
    findings.push({
      key: "no-root-config",
      detail: `biome config(s) present (${configs.join(", ")}) but no root biome.json extending ${PRESET_SPECIFIER}`,
    });
    return findings;
  }

  const config = readConfig(rootPath);
  if (config === undefined) {
    findings.push({ key: "unreadable", detail: "biome.json is not readable JSON" });
    return findings;
  }

  // (a) Extends the preset. The preset source extends its own file by path.
  const ext = extendsList(config);
  const conforms = source
    ? ext.some((e) => e.endsWith("configs/biome.json"))
    : ext.includes(PRESET_SPECIFIER);
  if (!conforms) {
    findings.push({
      key: "extends",
      detail:
        ext.length === 0
          ? `biome.json has no "extends" — it must extend ${PRESET_SPECIFIER}`
          : `biome.json extends ${ext.join(", ")} — it must extend ${PRESET_SPECIFIER}`,
    });
  }

  // (b) Does not restate what the preset decides.
  const owned = PRESET_OWNED.filter(
    (k) =>
      config[k] !== undefined && !(k === "linter" && linterIsDeclared(config.linter, declarations)),
  );
  const nested = PRESET_OWNED_NESTED.filter(
    (k) => (config[k] as Record<string, unknown> | undefined)?.formatter !== undefined,
  ).map((k) => `${k}.formatter`);
  const restated = [...owned, ...nested];
  if (restated.length > 0) {
    findings.push({
      key: "own-keys",
      detail: `biome.json carries its own ${restated.join(", ")} — the preset owns these`,
    });
  }

  const badOverrides = offendingOverrides(config, declarations);
  if (badOverrides.length > 0) {
    findings.push({
      key: "overrides",
      detail: `${badOverrides.join(", ")} — an override may only scope paths, turn suspicious.noConsole off, or turn off a rule declared in [[override]]`,
    });
  }

  return findings;
}

/** A top-level `linter` holding only `rules`, every one of them declared repo-wide. */
function linterIsDeclared(linter: unknown, declarations: readonly OverrideDeclaration[]): boolean {
  if (typeof linter !== "object" || linter === null) return false;
  const keys = Object.keys(linter);
  if (keys.length !== 1 || keys[0] !== "rules") return false;
  const rules = (linter as { rules: unknown }).rules;
  if (typeof rules !== "object" || rules === null) return false;
  const named = Object.entries(rules).flatMap(([group, body]) =>
    typeof body === "object" && body !== null ? Object.keys(body).map((r) => `${group}/${r}`) : [],
  );
  return named.length > 0 && named.every((r) => declaredEscape(declarations, r, []));
}

/** The one-line message the gate prints; "" when there is no drift. */
export function driftMessage(findings: DriftFinding[]): string {
  if (findings.length === 0) return "";
  return `biome preset drift: ${findings.map((f) => f.detail).join("; ")}. One preset everywhere — extend ${PRESET_SPECIFIER} and delete the local copy.`;
}
