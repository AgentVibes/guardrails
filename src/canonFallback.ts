import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { match } from "ts-pattern";
import { PACKAGE_NAME, packageRoot, packageVersion } from "./packagePaths.js";

// A wired repo's sgconfig.yml loads the canon from
// `node_modules/@agentvibes/guardrails/rules`. In a checkout whose
// dependencies were never installed (a fresh worktree, a nightly sweep) that
// directory does not exist, ast-grep exits 6 and the repo's findings could
// not be measured at all. The rules the config asks for ARE at hand: they are
// the rules of the guardrails install that is running. So the scan uses a
// temporary copy of the config whose missing canon dirs point at the running
// package, and the command says it did (canonFallbackNote).
//
// Only a missing dir under node_modules/@agentvibes/guardrails/ is remapped,
// and only when the running package has the same subdirectory. Any other
// missing dir is left as written, so ast-grep still fails on it and the
// AstGrepConfigError reports it. The repo's file is never edited, and the
// temporary copy lives outside the repo (snapshot writes nothing there).

const CANON_PREFIX = `node_modules/${PACKAGE_NAME}/`;

/** The `ruleDirs` / `utilDirs` lists ast-grep resolves against the config's directory. */
const PATH_LISTS = ["ruleDirs", "utilDirs"];

export type CanonFallback =
  | { kind: "none" }
  | {
      kind: "used";
      /** The dirs as written in the repo config that were missing. */
      missing: string[];
      /** The running install those dirs were taken from. */
      version: string;
      packageRoot: string;
      /** The temporary config ast-grep scans with. */
      config: string;
    };

/** `rules` for `node_modules/@agentvibes/guardrails/rules` (also with a leading `./`); undefined otherwise. */
function canonSubpath(dir: string): string | undefined {
  const plain = dir.replace(/^\.\//, "").replace(/\/+$/, "");
  return plain.startsWith(CANON_PREFIX) ? plain.slice(CANON_PREFIX.length) : undefined;
}

/** A list item's replacement in the temporary config, and whether it was a remapped canon dir. */
function rewriteItem(cwd: string, dir: string): { path: string; remapped: boolean } {
  const sub = canonSubpath(dir);
  if (sub !== undefined && !existsSync(resolve(cwd, dir)) && existsSync(join(packageRoot, sub)))
    return { path: join(packageRoot, sub), remapped: true };
  return { path: isAbsolute(dir) ? dir : resolve(cwd, dir), remapped: false };
}

/**
 * The repo config's text with every path-list item made absolute and the
 * missing canon dirs pointed at the running package. A line reader, like
 * declaredRuleDirs: the config shape the stub writes is a block list.
 */
function rewriteConfig(cwd: string, text: string): { text: string; missing: string[] } {
  const missing: string[] = [];
  let inList = false;
  const lines = text.split("\n").map((line) => {
    const key = /^([A-Za-z]+):/.exec(line)?.[1];
    if (key !== undefined) {
      inList = PATH_LISTS.includes(key);
      return line;
    }
    if (!inList) return line;
    const item = /^(\s+-\s*)(.+?)\s*$/.exec(line);
    const [, lead, dir] = item ?? [];
    if (lead === undefined || dir === undefined || dir.startsWith("#")) return line;
    const out = rewriteItem(cwd, dir);
    if (out.remapped) missing.push(dir);
    return `${lead}${JSON.stringify(out.path)}`;
  });
  return { text: lines.join("\n"), missing };
}

const made = new Map<string, CanonFallback>();
const tempDirs: string[] = [];
process.on("exit", () => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Whether the repo config at `configPath` (the repo's sgconfig.yml) needs the
 * running package's canon, and the temporary config to scan with when it
 * does. Made once per config per process.
 */
export function canonFallback(cwd: string, configPath: string): CanonFallback {
  const cached = made.get(configPath);
  if (cached !== undefined) return cached;
  const { text, missing } = rewriteConfig(cwd, readFileSync(configPath, "utf8"));
  const result: CanonFallback =
    missing.length === 0
      ? { kind: "none" }
      : { kind: "used", missing, version: packageVersion(), packageRoot, config: writeTemp(text) };
  made.set(configPath, result);
  return result;
}

function writeTemp(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-sgconfig-"));
  tempDirs.push(dir);
  const config = join(dir, "sgconfig.yml");
  writeFileSync(config, text);
  return config;
}

/** One line for a command's output; undefined when no fallback was used. */
export function canonFallbackNote(f: CanonFallback): string | undefined {
  return match(f)
    .with({ kind: "none" }, () => undefined)
    .with(
      { kind: "used" },
      (u) =>
        `sgconfig.yml lists ${u.missing.join(", ")}, which is not installed in this checkout; ` +
        `scanned with the rules of the running ${PACKAGE_NAME} ${u.version} instead`,
    )
    .exhaustive();
}
