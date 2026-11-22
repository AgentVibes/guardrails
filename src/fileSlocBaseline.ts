import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { match } from "ts-pattern";
import { TEST_FILE_PATH } from "./testPaths.js";
import { readTomlTable } from "./tomlTable.js";

// Per-file length ratchet. A file may hold at most `threshold` SLOC (default
// 500, tests excluded — see EXCLUDED_FILE in fileSloc.ts). Files that were
// already longer when the ratchet was adopted are listed in a committed
// baseline, `.guardrails/file-sloc.json`, each with its own ceiling:
//
//   - a listed file fails when it grows past its ceiling;
//   - any other file fails when it crosses the threshold;
//   - `--update-baseline` lowers a ceiling when its file shrank, and drops the
//     entry once the file is back under the threshold or gone.
//
// Updating never loosens: it never raises a ceiling and never lists a new
// file. Only the first creation and `--force` (a reviewed commit) do. SLOC is
// an exact integer, so unlike the project-wide metrics there is no
// hysteresis: any shrink tightens.

export const DEFAULT_MAX_FILE_SLOC = 500;

/**
 * Whether a file (by baseline key) is under the length ratchet. Test code is
 * not: besides the `*.test.*` files every metric drops (EXCLUDED_FILE), a file
 * in a test directory (`tests/`, `e2e/`, `__mocks__/`, …) is test code too,
 * such as a shared harness or an end-to-end script. The project-wide metrics
 * keep their own file set, so their committed baselines do not move.
 */
export function lengthGated(key: string): boolean {
  return !TEST_FILE_PATH.test(key);
}
export const FILE_SLOC_RULE = "file-sloc";

export class FileSlocConfigError extends Error {}

export interface FileSlocBaseline {
  version: 1;
  /** the threshold in force when the file was written — informational */
  threshold: number;
  /** repo-relative POSIX path → SLOC ceiling */
  files: Record<string, number>;
}

export type FileSlocViolation =
  | { kind: "grew"; file: string; sloc: number; ceiling: number }
  | { kind: "crossed"; file: string; sloc: number; threshold: number };

export function fileSlocBaselinePath(cwd: string): string {
  return join(cwd, ".guardrails", "file-sloc.json");
}

/** Baseline key of a file: relative to the directory the gate runs in, POSIX separators. */
export function baselineKey(cwd: string, file: string): string {
  return relative(cwd, resolve(cwd, file)).split(sep).join("/");
}

function parsePositiveInt(raw: string, source: string): number {
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0) {
    throw new FileSlocConfigError(
      `${source} = ${JSON.stringify(raw)} — must be a positive integer (SLOC per file).`,
    );
  }
  return Number(raw);
}

/**
 * The threshold: env `GUARDRAILS_MAX_FILE_SLOC`, else `[metrics] max_file_sloc`
 * in .agentvibes/project.toml, else 500. A value that is not a positive
 * integer throws FileSlocConfigError (exit 2) — never a silent default.
 */
export function maxFileSloc(cwd: string): number {
  const env = process.env.GUARDRAILS_MAX_FILE_SLOC;
  if (env !== undefined && env !== "") return parsePositiveInt(env, "GUARDRAILS_MAX_FILE_SLOC");
  const raw = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "metrics").max_file_sloc;
  if (raw === undefined) return DEFAULT_MAX_FILE_SLOC;
  return parsePositiveInt(raw, "[metrics] max_file_sloc in .agentvibes/project.toml");
}

function isBaseline(value: unknown): value is FileSlocBaseline {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.threshold !== "number") return false;
  if (typeof v.files !== "object" || v.files === null || Array.isArray(v.files)) return false;
  return Object.values(v.files).every((n) => Number.isInteger(n) && (n as number) > 0);
}

export type BaselineRead = { kind: "absent" } | { kind: "present"; baseline: FileSlocBaseline };

export function readFileSlocBaseline(path: string): BaselineRead {
  if (!existsSync(path)) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new FileSlocConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isBaseline(parsed)) {
    throw new FileSlocConfigError(
      `${path} has an unrecognised shape (want {version: 1, threshold, files: {path: sloc}}) — regenerate with \`guardrails metrics --update-baseline --force\``,
    );
  }
  return { kind: "present", baseline: parsed };
}

export function writeFileSlocBaseline(path: string, baseline: FileSlocBaseline): void {
  const files = Object.fromEntries(
    Object.entries(baseline.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...baseline, files }, null, 2)}\n`);
}

/**
 * Judge measured files. `measured` maps baseline key → SLOC. `renamedFrom`
 * maps a renamed file's key to the key it had before, so a renamed listed
 * file keeps its ceiling.
 */
export function checkFileSloc(
  measured: Map<string, number>,
  baseline: Record<string, number>,
  threshold: number,
  renamedFrom: Map<string, string> = new Map(),
): FileSlocViolation[] {
  const out: FileSlocViolation[] = [];
  for (const [file, sloc] of measured) {
    const before = renamedFrom.get(file);
    const ceiling = baseline[file] ?? (before === undefined ? undefined : baseline[before]);
    if (ceiling !== undefined) {
      if (sloc > ceiling) out.push({ kind: "grew", file, sloc, ceiling });
    } else if (sloc > threshold) {
      out.push({ kind: "crossed", file, sloc, threshold });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export interface FileSlocUpdate {
  next: FileSlocBaseline;
  /** ceiling lowered to the file's current SLOC */
  tightened: { file: string; from: number; to: number }[];
  /** dropped: back under the threshold, or the file is gone */
  dropped: string[];
  /** newly listed (only on creation or --force) */
  added: string[];
  /** over their ceiling or over the threshold unlisted — kept as they were */
  held: FileSlocViolation[];
}

/**
 * The next baseline. `old` undefined = creation: every file over the threshold
 * is listed at its current SLOC. `force` = the same from scratch over the
 * measured files. Otherwise ceilings only go down. Entries for files that were
 * not measured (outside the targets of this run) are kept unless the file no
 * longer exists. A listed file that was renamed (`renamedFrom`: new key → old
 * key) carries its ceiling to the new key.
 */
export function updateFileSloc(
  old: FileSlocBaseline | undefined,
  measured: Map<string, number>,
  threshold: number,
  force: boolean,
  exists: (key: string) => boolean,
  renamedFrom: Map<string, string> = new Map(),
): FileSlocUpdate {
  const tightened: FileSlocUpdate["tightened"] = [];
  const dropped: string[] = [];
  const added: string[] = [];
  const files: Record<string, number> = {};
  const listAll = old === undefined || force;

  const oldFiles = { ...(old?.files ?? {}) };
  for (const [to, from] of renamedFrom) {
    const ceiling = oldFiles[from];
    if (ceiling === undefined || oldFiles[to] !== undefined || exists(from)) continue;
    delete oldFiles[from];
    oldFiles[to] = ceiling;
  }
  for (const [file, ceiling] of Object.entries(oldFiles)) {
    const sloc = measured.get(file);
    if (sloc === undefined) {
      // A test-directory file listed by an older guardrails is no longer gated.
      if (exists(file) && lengthGated(file)) files[file] = ceiling;
      else dropped.push(file);
      continue;
    }
    if (sloc <= threshold) {
      dropped.push(file);
    } else if (listAll || sloc < ceiling) {
      files[file] = sloc;
      if (sloc < ceiling) tightened.push({ file, from: ceiling, to: sloc });
    } else {
      files[file] = ceiling;
    }
  }
  if (listAll) {
    for (const [file, sloc] of measured) {
      if (sloc > threshold && files[file] === undefined) {
        files[file] = sloc;
        added.push(file);
      }
    }
  }
  const next: FileSlocBaseline = { version: 1, threshold, files };
  const held = listAll ? [] : checkFileSloc(measured, files, threshold);
  return { next, tightened, dropped: dropped.sort(), added: added.sort(), held };
}

export function describeViolation(v: FileSlocViolation, baselineRel: string): string {
  return match(v)
    .with(
      { kind: "grew" },
      (g) =>
        `${g.file} has ${g.sloc} SLOC, over its ceiling of ${g.ceiling} in ${baselineRel} (+${g.sloc - g.ceiling}). A listed file may only shrink: split it rather than grow it.`,
    )
    .with(
      { kind: "crossed" },
      (c) =>
        `${c.file} has ${c.sloc} SLOC, over the ${c.threshold}-SLOC file limit (+${c.sloc - c.threshold}). Split the file; files over the limit are allowed only when listed in ${baselineRel}.`,
    )
    .exhaustive();
}
