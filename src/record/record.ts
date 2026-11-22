import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { match } from "ts-pattern";
import type { Override } from "../overrides.js";
import { packageRoot } from "../packagePaths.js";
import { resolvedVersion } from "../toolResolve.js";
import type { WiringReport } from "../wiring.js";
import { recordTarget } from "./config.js";
import { currentBranch, headSha, repoIdentity } from "./repoKey.js";
import type { FindingsData, Part, RunRecord, RunScope } from "./runRecord.js";
import { SKIPPED } from "./runRecord.js";
import { openDatabase, writeRun } from "./writer.js";

// The bridge between a command and the database. cli.ts makes one
// RunCollector per run and hands it to the command; the command fills the
// parts it measured; cli.ts then calls recordRun with the exit code. A
// command checks `collector.recording` before doing work that only the
// record needs (verify-diff's override walk), so an unrecorded run costs
// nothing extra.

export class RunCollector {
  findings: Part<FindingsData> = SKIPPED;
  overrides: Part<Override[]> = SKIPPED;
  wiring: Part<WiringReport> = SKIPPED;
  metrics: Part<Record<string, number>> = SKIPPED;

  constructor(
    /** Whether this run will be recorded; computed once from the environment. */
    readonly recording: boolean,
    readonly root: string = process.cwd(),
  ) {}

  /** Records metrics by name. Several calls in one run merge, the later value winning. */
  addMetrics(scope: RunScope, values: Record<string, number>): void {
    const finite = Object.entries(values).filter(([, n]) => Number.isFinite(n));
    const previous = match(this.metrics)
      .with({ status: "measured" }, (p) => p.data)
      .with({ status: "unavailable" }, { status: "skipped" }, () => ({}))
      .exhaustive();
    this.metrics = {
      status: "measured",
      scope,
      data: { ...previous, ...Object.fromEntries(finite) },
    };
  }
}

/** `full` when the run looked at the whole checkout, `paths` when it was given a subset. */
export function scopeOf(targets: readonly string[]): RunScope {
  const whole = targets.every((t) => resolve(t) === resolve("."));
  return whole ? "full" : "paths";
}

export type RecordOutcome =
  | { status: "off" }
  | { status: "recorded"; db: string; runId: number }
  | { status: "failed"; db: string | undefined; error: string };

function guardrailsVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** Whether a run of this kind records: the variable says yes, or `force` (snapshot). */
export function shouldRecord(force = false): boolean {
  try {
    return recordTarget(process.env, force).status === "on";
  } catch {
    // A broken user config must still reach recordRun, which reports it.
    return true;
  }
}

export interface RunMeta {
  command: string;
  exitCode: number;
  durationMs: number;
  startedAt: Date;
  /** snapshot: record even when GUARDRAILS_RECORD is unset. */
  force?: boolean;
}

/**
 * Stores what the collector saw. It never throws: a database that cannot be
 * written must not change a gate's verdict, so a failure is one line on
 * stderr and an outcome the caller may act on (snapshot exits non-zero).
 */
export async function recordRun(c: RunCollector, meta: RunMeta): Promise<RecordOutcome> {
  let db: string | undefined;
  try {
    const target = recordTarget(process.env, meta.force ?? false);
    return await match(target)
      .with({ status: "off" }, async () => ({ status: "off" }) as const)
      .with({ status: "on" }, async (t) => {
        db = t.db;
        const record: RunRecord = {
          repo: repoIdentity(c.root),
          root: resolve(c.root),
          command: meta.command,
          at: meta.startedAt.toISOString(),
          sha: headSha(c.root),
          branch: currentBranch(c.root),
          durationMs: meta.durationMs,
          exitCode: meta.exitCode,
          tools: {
            guardrails: guardrailsVersion(),
            node: process.version,
            astGrep: resolvedVersion("ast-grep"),
            biome: resolvedVersion("biome"),
          },
          findings: c.findings,
          overrides: c.overrides,
          wiring: c.wiring,
          metrics: c.metrics,
        };
        const handle = await openDatabase(t.db);
        try {
          return { status: "recorded", db: t.db, runId: writeRun(handle, record) } as const;
        } finally {
          handle.close();
        }
      })
      .exhaustive();
  } catch (err) {
    const error = (err as Error).message.split("\n")[0] ?? String(err);
    console.error(
      `guardrails: recording ${meta.command} to ${db ?? "the database"} failed: ${error}`,
    );
    return { status: "failed", db, error };
  }
}
