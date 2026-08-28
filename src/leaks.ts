import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LEAK_PATTERNS } from "./leakPatterns.js";
import { tryResolveTool } from "./toolResolve.js";

// `guardrails leaks [paths]` — the public/private boundary gate (spec layer
// A″). Scans every text file for private-infrastructure markers and token
// patterns; exit 1 on any hit. Runs in this repo's own pnpm check + CI so the
// package can never ship a hostname of the topology it deploys to, and is
// reusable as-is in any other public repo's gate.

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo", "build", ".next"]);
// The marker list itself (source + built twins) is the one sanctioned home of
// the patterns; scanning it would make the gate fail on its own definition.
const SELF_EXEMPT = /^leakPatterns\.(ts|js|d\.ts)(\.map)?$/;

export interface LeakFinding {
  file: string;
  line: number;
  patternId: string;
}

function isTextFile(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

function walk(path: string, out: string[]): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (!SELF_EXEMPT.test(basename(path)) && !path.endsWith(".tgz")) out.push(path);
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(path, entry), out);
  }
}

export function scanForLeaks(targets: string[]): LeakFinding[] {
  const files: string[] = [];
  for (const t of targets) walk(t, files);

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
      for (const p of LEAK_PATTERNS) {
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

export function runLeaks(targets: string[], json: boolean): number {
  const paths = targets.length > 0 ? targets : ["."];
  const findings = scanForLeaks(paths);
  const gitleaks = runGitleaks(paths[0] ?? ".");
  const ok = findings.length === 0 && gitleaks.ok;

  if (json) {
    console.log(
      JSON.stringify({ command: "leaks", targets: paths, ok, findings, gitleaks }, null, 2),
    );
    return ok ? 0 : 1;
  }
  for (const f of findings) {
    console.log(`error[leak:${f.patternId}]: ${f.file}:${f.line}`);
  }
  console.log(gitleaks.detail);
  if (ok) {
    console.log(`guardrails leaks: OK — no private-infrastructure markers in ${paths.join(" ")}`);
    return 0;
  }
  console.log(
    `guardrails leaks: ${findings.length} marker finding(s)${gitleaks.ok ? "" : " + gitleaks findings"}. Public code holds mechanisms; private facts (hostnames, paths, org names, tokens) belong in the private ops package / project config.`,
  );
  return 1;
}
