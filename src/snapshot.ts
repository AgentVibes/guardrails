import { existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { match } from "ts-pattern";
import { canonFallbackNote } from "./canonFallback.js";
import type { Finding } from "./findings.js";
import { hasLanguage, type LanguageId, resolveLanguages } from "./lang/languages.js";
import { rustVerifyFindings } from "./lang/rust/rustFindings.js";
import { recordedMetrics } from "./metrics.js";
import { aggregate } from "./metricsAggregate.js";
import { collectMetrics } from "./metricsCollect.js";
import { collectOverrides, type OverrideReport } from "./overrides.js";
import { driftMessage, presetDrift } from "./presetDrift.js";
import { type RunCollector, recordLanguageFindings, recordRun } from "./record/record.js";
import { repoMetrics } from "./record/repoMetrics.js";
import type { FindingsData, Part } from "./record/runRecord.js";
import { repoCanonFallback } from "./repoRules.js";
import { severityRaiseArgs } from "./severity.js";
import { collectVerifyFindings } from "./verify.js";
import { detectWiring } from "./wiring.js";

// `guardrails snapshot [path]`: observe one checkout and record it, whether
// or not that repo uses guardrails. It always records (GUARDRAILS_RECORD
// unset means the default database), never gates, and writes nothing into
// the repo it observes.
//
// Every part is attempted separately. A part that fails (a repo sgconfig
// pointing at a canon that is not installed, preset drift, a bad
// [[override]] table) is recorded `unavailable` with its reason and the
// others still run: a repo with no guardrails at all is wiring `off` with its
// metrics, not a failed snapshot.

function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split("\n")[0] ?? "";
}

/** Runs one measurement; a throw becomes `unavailable` with the error's first line. */
function attempt<T>(measure: () => T): Part<T> {
  try {
    return { status: "measured", scope: "full", data: measure() };
  } catch (err) {
    return { status: "unavailable", reason: firstLine(err) };
  }
}

function measure(run: RunCollector): void {
  const root = run.root;
  const overrides: Part<OverrideReport> = attempt(() => collectOverrides(root));
  run.overrides = match(overrides)
    .with({ status: "measured" }, (p) => ({ ...p, data: p.data.overrides }))
    .with({ status: "unavailable" }, { status: "skipped" }, (p) => p)
    .exhaustive();
  const report = match(overrides)
    .with({ status: "measured" }, (p) => p.data)
    .with({ status: "unavailable" }, { status: "skipped" }, () => undefined)
    .exhaustive();

  // A [languages] table that cannot be read leaves the findings unavailable;
  // wiring and metrics are still measured on what the checkout looks like.
  const langs = attempt(() => resolveLanguages(root).languages);
  run.findings = match(langs)
    .with({ status: "measured" }, (l) => measureFindings(run, root, l.data, report))
    .with({ status: "unavailable" }, { status: "skipped" }, (p) => p)
    .exhaustive();
  run.wiring = attempt(() => detectWiring(root, report));
  run.metrics = attempt(() => {
    const m = aggregate(collectMetrics(["."]));
    return { ...recordedMetrics(m), ...repoMetrics(m, root) };
  });
}

/**
 * Every enabled language's findings. A language that cannot be measured is
 * recorded per language with its reason (record.ts), TypeScript included, and
 * the resolved languages are always recorded. The whole-run part keeps its
 * old all-or-nothing rule: when TypeScript is unavailable (preset drift, a
 * config ast-grep cannot load) the run's findings are unavailable with the
 * TypeScript reason, even if Rust was measured.
 */
function measureFindings(
  run: RunCollector,
  root: string,
  languages: LanguageId[],
  report: OverrideReport | undefined,
): Part<FindingsData> {
  const ts: Part<Finding[]> = hasLanguage(languages, "typescript")
    ? attempt(() => {
        const drift = presetDrift(root);
        if (drift.length > 0) throw new Error(driftMessage(drift));
        return collectVerifyFindings(["."], severityRaiseArgs(root), root);
      })
    : { status: "skipped" };
  const list: Finding[] = match(ts)
    .with({ status: "measured" }, (p) => [...p.data])
    .with({ status: "unavailable" }, { status: "skipped" }, () => [])
    .exhaustive();
  const counts: Partial<Record<LanguageId, number>> = match(ts)
    .with({ status: "measured" }, (p) => ({ typescript: p.data.length }))
    .with({ status: "unavailable" }, { status: "skipped" }, () => ({}))
    .exhaustive();
  const unavailable: { language: LanguageId; reason: string }[] = match(ts)
    .with({ status: "unavailable" }, (p) => [{ language: "typescript" as const, reason: p.reason }])
    .with({ status: "measured" }, { status: "skipped" }, () => [])
    .exhaustive();
  list.push(...(report?.findings ?? []));
  if (hasLanguage(languages, "rust")) {
    const rust = rustVerifyFindings(root, "snapshot");
    list.push(
      ...rust.findings.map((f) => ({
        ...f,
        file: relative(root, f.file).split(sep).join("/"),
      })),
    );
    unavailable.push(...rust.unavailable.map((reason) => ({ language: "rust" as const, reason })));
    if (rust.unavailable.length === 0) counts.rust = rust.findings.length;
  }
  run.findings = { status: "measured", scope: "full", data: { tiers: "all", list } };
  // May turn the part unavailable when no language could be measured.
  recordLanguageFindings(run, "full", { languages, counts, unavailable });
  // TypeScript unavailable: the whole-run part is the TypeScript part, as before.
  run.findings = match(ts)
    .with({ status: "unavailable" }, (p): Part<FindingsData> => p)
    .with({ status: "measured" }, { status: "skipped" }, () => run.findings)
    .exhaustive();
  return run.findings;
}

/** Whether the TypeScript findings of this run were measured. */
function typescriptMeasured(run: RunCollector): boolean {
  return run.languageFindings.some(
    (l) =>
      l.language === "typescript" &&
      match(l.part)
        .with({ status: "measured" }, () => true)
        .with({ status: "unavailable" }, { status: "skipped" }, () => false)
        .exhaustive(),
  );
}

function partLine<T>(name: string, part: Part<T>, summary: (data: T) => string): string {
  return match<Part<T>>(part)
    .with({ status: "measured" }, (p) => `${name} ${summary(p.data)}`)
    .with({ status: "unavailable" }, (p) => `${name} unavailable (${p.reason})`)
    .with({ status: "skipped" }, () => `${name} skipped`)
    .exhaustive();
}

export async function runSnapshot(
  targets: string[],
  json: boolean,
  run: RunCollector,
): Promise<number> {
  if (targets.length > 1) {
    console.error(`guardrails snapshot: one path at a time (got ${targets.length})`);
    return 2;
  }
  const root = resolve(targets[0] ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`guardrails snapshot: not a directory: ${root}`);
    return 2;
  }
  const startedAt = new Date();
  const started = performance.now();
  // The scanners read the current directory (ast-grep's .gitignore, the
  // repo's sgconfig.yml and project.toml), so the snapshot runs inside the
  // observed repo. The database path was resolved before this (RunCollector).
  process.chdir(root);
  run.root = root;
  measure(run);
  // Said in the output: the findings came from the running package's canon,
  // not from the version the repo would install (canonFallback.ts). Only when
  // TypeScript was actually scanned: preset drift stops it before ast-grep.
  const notes = typescriptMeasured(run)
    ? [canonFallbackNote(repoCanonFallback(root))].filter((n): n is string => n !== undefined)
    : [];

  const outcome = await recordRun(run, {
    command: "snapshot",
    exitCode: 0,
    durationMs: performance.now() - started,
    startedAt,
  });
  const parts = [
    partLine("wiring", run.wiring, (w) => w.state),
    partLine("findings", run.findings, (f) => {
      const errors = f.list.filter((x) => x.severity === "error").length;
      return `${errors} error(s), ${f.list.length - errors} other`;
    }),
    partLine("overrides", run.overrides, (o) => `${o.length}`),
    partLine("metrics", run.metrics, (m) => `${Object.keys(m).length} recorded`),
  ];
  return match(outcome)
    .with({ status: "recorded" }, (o) => {
      if (json) {
        console.log(
          JSON.stringify(
            { command: "snapshot", root, db: o.db, runId: o.runId, parts, notes },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `guardrails snapshot: ${root} → ${o.db} (run ${o.runId})\n  ${[...parts, ...notes.map((n) => `note: ${n}`)].join("\n  ")}`,
        );
      }
      return 0;
    })
    .with({ status: "failed" }, () => 2)
    .with({ status: "off" }, () => {
      // resolveTarget(true) never yields "off"; reaching this is a defect.
      console.error("guardrails snapshot: recording was off — this is a guardrails bug");
      return 2;
    })
    .exhaustive();
}
