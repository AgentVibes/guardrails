import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { readTomlTable } from "./tomlTable.js";

// Preset-drift guard (is-9c7a78d7). The migration epic is-a70a5963 collapses 37
// hand-rolled biome configs into one preset; nothing stopped a repo from
// re-growing its own the week after. Owner's rule, 2026-09-03: «we should only
// use agentvibes … no need to have many biome configs». So the tool is the
// enforcement, not the convention.
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
 * (epic is-a70a5963): 110 occurrences in byoklab/agent-workbench, almost all in
 * `__tests__/`, and 16 in @agentvibes/kit. Writing a suppression comment on
 * every one of them is noise, not review. Owner's call, 2026-09-07: a per-repo
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
function testScoped(entry: Record<string, unknown>): boolean {
  const raw = entry.includes ?? entry.files;
  if (!Array.isArray(raw)) return false;
  const positive = raw.filter((g): g is string => typeof g === "string" && !g.startsWith("!"));
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

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".git",
  "coverage",
  ".turbo",
  ".claude",
]);

/** Every biome config in the tree, repo-root-relative, excluding SKIP_DIRS. */
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
function offendingOverrides(config: BiomeConfig): string[] {
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
      // A linter override may touch exactly two rules, both under `suspicious`,
      // and nothing else: `noConsole` (a CLI has to print) and
      // `noEmptyBlockStatements` SCOPED TO TESTS. See OVERRIDABLE below.
      const rules = (o.linter as Record<string, unknown> | undefined)?.rules;
      const groups =
        typeof rules === "object" && rules !== null ? (rules as Record<string, unknown>) : {};
      const groupNames = Object.keys(groups);
      const onlySuspicious = groupNames.length === 1 && groupNames[0] === "suspicious";
      const suspicious = groups.suspicious;
      const ruleNames =
        typeof suspicious === "object" && suspicious !== null ? Object.keys(suspicious) : [];
      const allOverridable = ruleNames.length > 0 && ruleNames.every((r) => OVERRIDABLE.has(r));
      if (!onlySuspicious || !allOverridable) {
        bad.push(
          `overrides[${i}].linter.rules (only ${[...OVERRIDABLE].map((r) => `suspicious.${r}`).join(" and ")} may be overridden)`,
        );
        continue;
      }
      // The empty-block carve-out is for TEST code only. Unscoped, it would be
      // the whole rule switched off through a loophole.
      if (ruleNames.includes("noEmptyBlockStatements") && !testScoped(o)) {
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
  const owned = PRESET_OWNED.filter((k) => config[k] !== undefined);
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

  const badOverrides = offendingOverrides(config);
  if (badOverrides.length > 0) {
    findings.push({
      key: "overrides",
      detail: `${badOverrides.join(", ")} — an override may only scope paths and turn suspicious.noConsole off`,
    });
  }

  return findings;
}

/**
 * Whether drift GATES in this repo, from `[biome] preset = "enforced"` in
 * `.agentvibes/project.toml`.
 *
 * Opt-in per repo, then flipped (owner, 2026-09-06). Failing every repo the day
 * this shipped would have turned 5 of the 7 repos that run this gate red —
 * SiteCraftMonorepo, faceless-photo-lib, agent-session-observatory, tg-gallery,
 * merkle-substrate — before the migration issue for each was worked, blocking
 * unrelated work in all five. Each child of epic is-a70a5963 adds the line as
 * its last step; when the last child lands, this default flips to enforced.
 *
 * Unenforced is NOT silent: `verify` prints the drift as a note and `doctor`
 * always reports it. What the flag decides is the exit code, not the message.
 */
export function presetEnforced(cwd: string): boolean {
  return readTomlTable(join(cwd, ".agentvibes", "project.toml"), "biome").preset === "enforced";
}

/** The one-line message the gate prints; "" when there is no drift. */
export function driftMessage(findings: DriftFinding[]): string {
  if (findings.length === 0) return "";
  return `biome preset drift: ${findings.map((f) => f.detail).join("; ")}. One preset everywhere — extend ${PRESET_SPECIFIER} and delete the local copy (epic is-a70a5963).`;
}
