import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { LEAK_PATTERNS, type LeakPattern } from "./leakPatterns.js";
import { loadPlugin, resolvePluginName } from "./pluginResolve.js";
import { readTomlTable } from "./tomlTable.js";
import { tryResolveTool } from "./toolResolve.js";

// `guardrails leaks [paths]` — the public/private boundary gate (spec layer
// A″). The package ships only GENERIC credential patterns; house marker lists
// (a fact about a private topology) load at runtime from, in order:
//   1. built-ins (leakPatterns.ts)
//   2. .guardrails/leaks.txt in the target repo
//   3. the file named by `patterns_file =` under [leaks] in .agentvibes/project.toml
//   4. the project's guardrails plugin, via its optional leakPatterns() hook
// Exit 1 on any hit; exit 2 on an unloadable pattern (a gate that silently
// drops a bad pattern is a coverage hole nobody can see).

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo", "build", ".next"]);

export interface LeakFinding {
  file: string;
  line: number;
  patternId: string;
}

interface LoadedPatterns {
  patterns: LeakPattern[];
  /** human-readable provenance, e.g. "built-in (9), .guardrails/leaks.txt (7)" */
  sources: string[];
  /** absolute paths of pattern files — exempt from the scan (they contain their own markers) */
  exemptFiles: Set<string>;
}

class PatternLoadError extends Error {}

/**
 * Pattern-file format: one pattern per line, `#` comments and blanks skipped.
 * A line is `<id> <regex>` (split on first whitespace); a single-token line is
 * a bare regex with a generated id.
 */
function parsePatternFile(path: string): LeakPattern[] {
  const patterns: LeakPattern[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const sp = line.search(/\s/);
    const id = sp > 0 ? line.slice(0, sp) : `pattern-${i + 1}`;
    const source = sp > 0 ? line.slice(sp).trim() : line;
    try {
      patterns.push({ id, regex: new RegExp(source) });
    } catch (err) {
      throw new PatternLoadError(
        `${path}:${i + 1}: invalid regex '${source}' (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  });
  return patterns;
}

async function loadPatterns(cwd: string): Promise<LoadedPatterns> {
  const patterns = [...LEAK_PATTERNS];
  const sources = [`built-in generic (${LEAK_PATTERNS.length})`];
  const exemptFiles = new Set<string>();

  const fileCandidates = [join(cwd, ".guardrails", "leaks.txt")];
  const leaksConfig = readTomlTable(join(cwd, ".agentvibes", "project.toml"), "leaks");
  const configured = leaksConfig.patterns_file;
  if (configured !== undefined && configured !== "") {
    fileCandidates.push(isAbsolute(configured) ? configured : join(cwd, configured));
  }
  for (const candidate of fileCandidates) {
    const abs = resolve(candidate);
    if (!existsSync(abs) || exemptFiles.has(abs)) continue;
    const loaded = parsePatternFile(abs);
    patterns.push(...loaded);
    sources.push(`${abs} (${loaded.length})`);
    exemptFiles.add(abs);
  }

  const pluginName = resolvePluginName(cwd);
  if (pluginName !== undefined) {
    const plugin = await loadPlugin(cwd, pluginName);
    if (plugin.leakPatterns !== undefined) {
      const specs = plugin.leakPatterns();
      for (const spec of specs) {
        try {
          patterns.push({ id: spec.id, regex: new RegExp(spec.pattern) });
        } catch (err) {
          throw new PatternLoadError(
            `plugin ${plugin.name} leakPatterns(): invalid regex for '${spec.id}' (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      sources.push(`plugin ${plugin.name} (${specs.length})`);
    }
  }

  return { patterns, sources, exemptFiles };
}

function isTextFile(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

function walk(path: string, out: string[], exemptFiles: Set<string>): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (!exemptFiles.has(resolve(path)) && !path.endsWith(".tgz")) out.push(path);
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(path, entry), out, exemptFiles);
  }
}

export function scanForLeaks(
  targets: string[],
  patterns: LeakPattern[],
  exemptFiles: Set<string>,
): LeakFinding[] {
  const files: string[] = [];
  for (const t of targets) walk(t, files, exemptFiles);

  const findings: LeakFinding[] = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (!isTextFile(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      for (const p of patterns) {
        if (p.regex.test(line)) findings.push({ file, line: i + 1, patternId: p.id });
      }
    }
  }
  return findings;
}

interface GitleaksResult {
  ran: boolean;
  ok: boolean;
  detail: string;
}

function runGitleaks(target: string): GitleaksResult {
  const tool = tryResolveTool("gitleaks");
  if (tool === undefined) {
    return {
      ran: false,
      ok: true,
      detail:
        "gitleaks not found (PATH or mise) — pattern scan only. Install: mise use -g gitleaks@latest",
    };
  }
  const [cmd, ...prefix] = tool.argv;
  if (cmd === undefined) return { ran: false, ok: true, detail: "gitleaks argv empty" };
  const res = spawnSync(
    cmd,
    [...prefix, "detect", "--no-git", "--no-banner", "--redact", "--source", target],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error)
    return { ran: false, ok: true, detail: `gitleaks failed to start: ${res.error.message}` };
  // ast-grep-ignore: kind-if-without-match -- res.status is spawnSync's numeric exit code (number | null), not a discriminated-union tag
  if (res.status === 0) return { ran: true, ok: true, detail: `gitleaks ${tool.version}: clean` };
  return {
    ran: true,
    ok: false,
    detail: `gitleaks ${tool.version}: findings\n${res.stdout.slice(0, 4000)}${res.stderr.slice(0, 2000)}`,
  };
}

export async function runLeaks(targets: string[], json: boolean): Promise<number> {
  const paths = targets.length > 0 ? targets : ["."];

  let loaded: LoadedPatterns;
  try {
    loaded = await loadPatterns(process.cwd());
  } catch (err) {
    console.error(`guardrails leaks: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const findings = scanForLeaks(paths, loaded.patterns, loaded.exemptFiles);
  const gitleaks = runGitleaks(paths[0] ?? ".");
  const ok = findings.length === 0 && gitleaks.ok;

  if (json) {
    console.log(
      JSON.stringify(
        {
          command: "leaks",
          targets: paths,
          ok,
          patternSources: loaded.sources,
          findings,
          gitleaks,
        },
        null,
        2,
      ),
    );
    return ok ? 0 : 1;
  }
  console.log(`patterns: ${loaded.sources.join(", ")}`);
  for (const f of findings) {
    console.log(`error[leak:${f.patternId}]: ${f.file}:${f.line}`);
  }
  console.log(gitleaks.detail);
  if (ok) {
    console.log(`guardrails leaks: OK — no leak-pattern hits in ${paths.join(" ")}`);
    return 0;
  }
  console.log(
    `guardrails leaks: ${findings.length} finding(s)${gitleaks.ok ? "" : " + gitleaks findings"}. Public code holds mechanisms; private facts (hostnames, paths, org names, tokens) belong in the private ops package / project config.`,
  );
  return 1;
}
