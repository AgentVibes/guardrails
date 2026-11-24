import { spawnSync } from "node:child_process";
import { isAbsolute, join, normalize, sep } from "node:path";
import { match } from "ts-pattern";
import { z } from "zod";
import type { Finding } from "../../findings.js";
import type { CargoSelection, CargoTarget } from "./cargoConfig.js";

// Findings from `cargo clippy --message-format=json` and `cargo fmt --check`.
//
// Clippy runs with `-- --cap-lints warn`. Without the cap, one deny-level
// lint in a crate fails that crate's build and cargo never checks the crates
// that depend on it, even with --keep-going: their findings would be missing
// and the count would look smaller than it is. With the cap, every crate is
// checked; the original level is still in the message's notes ("requested on
// the command line with `-D …`", "`#[deny(…)]` on by default"), and is kept
// in the finding's message.
//
// For the gate (verify, verify-diff, hooks) every lint finding is ERROR
// tier: the canon runs clippy with -D warnings, so a warning fails the build
// exactly like a deny. Snapshot observes rather than gates, so it records
// each finding at the level clippy itself gave it (severity "clippy-level"):
// a warn-level lint is a warning there.
//
// Anything that is not a lint finding (a compile error E0308, a manifest
// that cargo cannot load, a missing toolchain, a timeout) makes the result
// `unavailable` with the reason. It is never "zero findings".

export type CargoResult =
  | { status: "ran"; findings: Finding[] }
  | { status: "unavailable"; reason: string };

const Span = z
  .object({
    file_name: z.string(),
    line_start: z.number(),
    is_primary: z.boolean(),
    text: z.array(z.object({ text: z.string() }).loose()).default([]),
  })
  .loose();

interface Diagnostic {
  message: string;
  level: string;
  code: { code: string } | null;
  spans: z.infer<typeof Span>[];
  children: Diagnostic[];
}

const DiagnosticSchema: z.ZodType<Diagnostic> = z.lazy(() =>
  z
    .object({
      message: z.string(),
      level: z.string(),
      code: z.object({ code: z.string() }).loose().nullable().default(null),
      spans: z.array(Span).default([]),
      children: z.array(DiagnosticSchema).default([]),
    })
    .loose(),
);

const CompilerMessage = z
  .object({
    reason: z.literal("compiler-message"),
    manifest_path: z.string().default(""),
    message: DiagnosticSchema,
  })
  .loose();

const AnyLine = z.object({ reason: z.string() }).loose();

/** A lint code (`clippy::unwrap_used`, `unused_variables`), as opposed to a compiler error code (`E0308`). */
export function isLintCode(code: string): boolean {
  return /^clippy::[a-z0-9_]+$/.test(code) || /^[a-z][a-z0-9_]*$/.test(code);
}

/** The level the repo's configuration gave the lint, before `--cap-lints warn` lowered it. */
export function originalLevel(d: Diagnostic): "deny" | "warn" {
  for (const c of d.children) {
    if (/`-[DF]\s/.test(c.message) || /#\[(?:deny|forbid)\(/.test(c.message)) return "deny";
    if (/lint level is defined here/.test(c.message)) {
      const text = c.spans.flatMap((s) => s.text.map((t) => t.text)).join(" ");
      if (/\b(?:deny|forbid)\s*\(/.test(text)) return "deny";
    }
  }
  return d.level === "error" ? "deny" : "warn";
}

function under(root: string, file: string): boolean {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Findings from clippy's JSON lines. `cargoRoot` resolves relative span paths;
 * spans outside `repoRoot` (dependencies, the standard library) are dropped.
 * Paths are absolute. A compile error makes the whole result unavailable.
 */
export type ClippySeverity = "canon" | "clippy-level";

export function parseClippyJson(
  output: string,
  cargoRoot: string,
  repoRoot: string,
  severity: ClippySeverity = "canon",
): CargoResult {
  const findings = new Map<string, Finding>();
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // ast-grep-ignore: catch-empty -- cargo interleaves non-JSON lines (build-script output) with the JSON stream; they carry no findings
      continue;
    }
    if (!AnyLine.safeParse(raw).success) continue;
    const parsed = CompilerMessage.safeParse(raw);
    if (!parsed.success) continue;
    const d = parsed.data.message;
    const code = d.code?.code;
    const primary = d.spans.find((s) => s.is_primary) ?? d.spans[0];
    const at =
      primary === undefined
        ? undefined
        : {
            file: normalize(
              isAbsolute(primary.file_name)
                ? primary.file_name
                : join(cargoRoot, primary.file_name),
            ),
            line: primary.line_start,
          };
    if (code !== undefined && isLintCode(code)) {
      if (at === undefined || !under(repoRoot, at.file)) continue;
      const level = originalLevel(d);
      const canon = severity === "canon";
      const f: Finding = {
        rule: code,
        severity: canon || level === "deny" ? "error" : "warning",
        file: at.file,
        line: at.line,
        message: `${d.message} (${code} is ${match({ level, canon })
          .with({ level: "deny" }, () => "deny")
          .with({ level: "warn", canon: true }, () => "warn, denied by -D warnings")
          .with({ level: "warn", canon: false }, () => "warn")
          .exhaustive()})`,
        source: code.startsWith("clippy::") ? "clippy" : "rustc",
      };
      // --all-targets checks a lib twice (lib, lib test): the same finding twice.
      findings.set(`${f.rule}\0${f.file}\0${f.line}\0${d.message}`, f);
      continue;
    }
    if (d.level === "error" || d.level === "error: internal compiler error") {
      // "aborting due to …" and "could not compile …" summaries have no span.
      if (at === undefined) continue;
      errors.push(`${code ?? "error"}: ${d.message} at ${at.file}:${at.line}`);
    }
  }
  if (errors.length > 0) {
    return {
      status: "unavailable",
      reason: `the build failed (${errors.length} compile error(s)); first: ${errors[0]}`,
    };
  }
  return { status: "ran", findings: [...findings.values()] };
}

/**
 * rustfmt's `--check` output: `Diff in <file>:<line>:` headers followed by a
 * unified diff. One finding per run of changed lines, at the first original
 * line it touches, so the diff ratchet can match it to an added line.
 */
export function parseFmtCheck(output: string): Finding[] {
  const out: Finding[] = [];
  let file: string | undefined;
  let line = 0;
  let inRun = false;
  for (const text of output.split("\n")) {
    const header = /^Diff in (.+):(\d+):\s*$/.exec(text);
    if (header !== null && header[1] !== undefined) {
      file = header[1];
      line = Number(header[2]);
      inRun = false;
      continue;
    }
    if (file === undefined) continue;
    const changed = text.startsWith("-") || text.startsWith("+");
    if (changed && !inRun) {
      out.push({
        rule: "rustfmt",
        severity: "error",
        file,
        line,
        message: "not formatted as rustfmt would (run cargo fmt)",
        source: "rustfmt",
      });
    }
    inRun = changed;
    // Original-file lines are the context and removed ones.
    if (text.startsWith(" ") || text.startsWith("-")) line++;
  }
  return out;
}

export interface CargoOptions {
  /** `--workspace [--exclude …]` or `-p …`. */
  selection: CargoSelection;
  /** `--target <triple>`, or the host. */
  target: CargoTarget;
  /** How a lint finding's severity is set (see the top of this file). */
  severity: ClippySeverity;
  timeoutMs: number | undefined;
  /** Extra environment (CARGO_TARGET_DIR for runs that must not write into the repo). */
  env?: Record<string, string> | undefined;
  /** `--locked`: fail rather than write Cargo.lock. */
  locked?: boolean | undefined;
}

function lastLines(text: string, n: number): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== "" &&
        !/^(?:Compiling|Checking|Blocking|Finished|Running|Updating|Downloaded|Downloading|Locking|Adding)\b/.test(
          l,
        ),
    )
    .slice(-n)
    .join(" / ");
}

function spawnCargo(
  cwd: string,
  args: string[],
  opts: CargoOptions,
):
  | { status: "done"; code: number; stdout: string; stderr: string }
  | { status: "failed"; reason: string } {
  // The caller's environment is passed through whole: RUSTC_WRAPPER (sccache),
  // CARGO_TARGET_DIR and the toolchain selection are the repo's, not ours.
  const res = spawnSync("cargo", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...opts.env },
    ...(opts.timeoutMs === undefined
      ? {}
      : { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const }),
  });
  if (res.error !== undefined) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "failed", reason: "cargo is not on PATH" };
    if (code === "ETIMEDOUT")
      return {
        status: "failed",
        reason: `cargo ${args[0]} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`,
      };
    return { status: "failed", reason: `cargo ${args[0]}: ${res.error.message}` };
  }
  if (res.signal !== null)
    return { status: "failed", reason: `cargo ${args[0]} was killed by ${res.signal}` };
  return { status: "done", code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** The selection and target as cargo arguments: `--workspace --exclude web`, `-p web --target wasm32-…`. */
export function selectionArgs(selection: CargoSelection, target: CargoTarget): string[] {
  const pick = match(selection)
    .with({ kind: "workspace" }, (s) => [
      "--workspace",
      ...s.exclude.flatMap((n) => ["--exclude", n]),
    ])
    .with({ kind: "packages" }, (s) => s.names.flatMap((n) => ["-p", n]))
    .exhaustive();
  const triple = match(target)
    .with({ kind: "host" }, () => [])
    .with({ kind: "triple" }, (t) => ["--target", t.triple])
    .exhaustive();
  return [...pick, ...triple];
}

export function runClippy(cargoRoot: string, repoRoot: string, opts: CargoOptions): CargoResult {
  const args = [
    "clippy",
    ...selectionArgs(opts.selection, opts.target),
    "--all-targets",
    "--message-format=json",
    "--keep-going",
    ...(opts.locked === true ? ["--locked"] : []),
    "--",
    "--cap-lints",
    "warn",
  ];
  return match(spawnCargo(cargoRoot, args, opts))
    .with({ status: "failed" }, (r): CargoResult => ({ status: "unavailable", reason: r.reason }))
    .with(
      { status: "done" },
      (res): CargoResult =>
        match(parseClippyJson(res.stdout, cargoRoot, repoRoot, opts.severity))
          .with({ status: "unavailable" }, (p) => p)
          .with(
            { status: "ran" },
            (p): CargoResult =>
              // With lints capped at warn, a non-zero exit is never "lints fired":
              // the manifest, the lock file, the toolchain or a build script failed.
              res.code === 0
                ? p
                : {
                    status: "unavailable",
                    reason: `cargo clippy exited ${res.code}: ${lastLines(res.stderr, 3) || "no message"}`,
                  },
          )
          .exhaustive(),
    )
    .exhaustive();
}

export function runFmtCheck(cargoRoot: string, opts: CargoOptions): CargoResult {
  return match(spawnCargo(cargoRoot, ["fmt", "--all", "--check"], opts))
    .with({ status: "failed" }, (r): CargoResult => ({ status: "unavailable", reason: r.reason }))
    .with({ status: "done" }, (res): CargoResult => {
      const findings = res.code === 0 ? [] : parseFmtCheck(res.stdout);
      // Exit 1 with diffs and a quiet stderr is "not formatted"; anything else
      // (a parse error, rustfmt missing) means the check did not run.
      return res.code === 0 || (findings.length > 0 && res.stderr.trim() === "")
        ? { status: "ran", findings }
        : {
            status: "unavailable",
            reason: `cargo fmt --check exited ${res.code}: ${lastLines(res.stderr, 3) || "no message"}`,
          };
    })
    .exhaustive();
}
