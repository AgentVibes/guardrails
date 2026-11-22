import { relative, resolve, sep } from "node:path";
import { AstGrepConfigError, scanFindings } from "./astGrep.js";
import { type Finding, formatFinding, hasErrors, isRustFinding } from "./findings.js";
import { dropJsxSuppressed } from "./jsxSuppress.js";
import { hasLanguage, type LanguageId, resolveLanguages } from "./lang/languages.js";
import { rustVerifyFindings } from "./lang/rust/rustFindings.js";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { collectOverrides, type Override } from "./overrides.js";
import { rulesConfig } from "./packagePaths.js";
import { driftMessage, presetDrift } from "./presetDrift.js";
import { type RunCollector, recordLanguageFindings, scopeOf } from "./record/record.js";
import { dedupeFindings, ruleConfigs } from "./repoRules.js";
import {
  dropScopeExempt,
  ScreenScopeError,
  scopeExemptRuleIds,
  scopePatterns,
} from "./screenScope.js";
import { SeverityConfigError, severityRaiseArgs } from "./severity.js";
import { structureFindings } from "./structure.js";
import { textGrepFindings } from "./textGrep.js";
import { RUST_SUPPRESS_HINT } from "./verifyDiff.js";
import { detectWiring } from "./wiring.js";

export function collectVerifyFindings(
  targets: string[],
  severityArgs: string[] = [],
  cwd: string = process.cwd(),
): Finding[] {
  // Canon first, then the repo's own sgconfig.yml when it has one — see
  // repoRules.ts for why both and not either alone. The repo config normally
  // lists the canon ruleDir too, so the overlap is deduped rather than
  // reported twice.
  const findings = dedupeFindings([
    ...ruleConfigs(cwd, rulesConfig).flatMap((c) => scanFindings(c, targets, severityArgs)),
    ...textGrepFindings(targets),
    ...structureFindings(targets),
  ]);
  // Applied HERE rather than in `runVerify`, so verify-diff and the hooks get
  // the same scoping: a screen that is legal under `verify` must not be gated
  // by `verify-diff` on the same line.
  // JSX-form suppressions last: they are a per-line exemption like ast-grep's
  // own, and must not change which rules a scope stands down.
  return dropJsxSuppressed(
    dropScopeExempt(findings, scopePatterns(cwd), scopeExemptRuleIds()),
    cwd,
  );
}

/** Rust findings under `paths`, with paths relative to cwd like the TypeScript ones. */
function rustUnder(cwd: string, paths: readonly string[], findings: Finding[]): Finding[] {
  const roots = paths.map((p) => resolve(cwd, p));
  return findings
    .filter((f) =>
      roots.some((r) => f.file === r || f.file.startsWith(r.endsWith(sep) ? r : r + sep)),
    )
    .map((f) => ({ ...f, file: relative(cwd, f.file).split(sep).join("/") }));
}

export function runVerify(targets: string[], json: boolean, run: RunCollector): number {
  const paths = targets.length > 0 ? targets : ["."];
  const scope = scopeOf(paths);

  let languages: LanguageId[];
  try {
    languages = resolveLanguages(process.cwd()).languages;
  } catch (err) {
    if (!(err instanceof OverrideConfigError)) throw err;
    run.findings = { status: "unavailable", reason: err.message };
    console.error(`guardrails verify: ${err.message}`);
    return 2;
  }
  const typescript = hasLanguage(languages, "typescript");

  // Preset drift is checked FIRST: a repo running its own biome
  // config is not being linted by the thing this gate reports on, so a finding
  // count from it means less than it looks. It gates in every TypeScript repo.
  const drift = typescript ? presetDrift(process.cwd()) : [];
  if (drift.length > 0) {
    run.findings = { status: "unavailable", reason: driftMessage(drift) };
    // Drift is exactly when wiring_preset must read 0, so wiring is still measured.
    if (run.recording)
      run.wiring = { status: "measured", scope: "full", data: detectWiring(process.cwd()) };
    console.error(`guardrails verify: ${driftMessage(drift)}`);
    return 2;
  }

  // Both manifest sections are resolved here so a config the gate cannot honour
  // exits 2 with the reason — never a stack trace, and never silently dropped.
  let findings: Finding[];
  let overrides: Override[];
  const unavailable: { language: LanguageId; reason: string }[] = [];
  const counts: Partial<Record<LanguageId, number>> = {};
  try {
    findings = typescript ? collectVerifyFindings(paths, severityRaiseArgs(process.cwd())) : [];
    if (typescript) counts.typescript = findings.length;
    if (hasLanguage(languages, "rust")) {
      const rust = rustVerifyFindings(process.cwd(), "verify");
      const own = rustUnder(process.cwd(), paths, rust.findings);
      findings = [...findings, ...own];
      unavailable.push(
        ...rust.unavailable.map((reason) => ({ language: "rust" as const, reason })),
      );
      if (rust.unavailable.length === 0) counts.rust = own.length;
    }
    // The overrides inventory (overrides.ts) is `verify`-only: a missing
    // reason is a warning for the repo to see, not something the per-edit
    // hooks or the diff ratchet should re-report on every change.
    const report = collectOverrides(process.cwd(), paths);
    overrides = report.overrides;
    findings = [...findings, ...report.findings];
    run.findings = { status: "measured", scope, data: { tiers: "all", list: findings } };
    run.overrides = { status: "measured", scope, data: overrides };
    recordLanguageFindings(run, scope, { languages, counts, unavailable });
    // Wiring is a property of the whole checkout, whatever paths were scanned.
    if (run.recording) {
      run.wiring = {
        status: "measured",
        scope: "full",
        data: detectWiring(process.cwd(), scope === "full" ? report : undefined),
      };
    }
  } catch (err) {
    if (
      err instanceof OverrideConfigError ||
      err instanceof SeverityConfigError ||
      err instanceof ScreenScopeError ||
      err instanceof AstGrepConfigError
    ) {
      run.findings = { status: "unavailable", reason: err.message };
      console.error(`guardrails verify: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  for (const u of unavailable)
    console.error(`guardrails verify: ${u.language} could not be checked: ${u.reason}`);

  if (json) {
    console.log(
      JSON.stringify(
        {
          command: "verify",
          targets: paths,
          languages,
          errors,
          warnings,
          findings,
          overrides,
          ...(unavailable.length > 0 ? { unavailable } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    for (const f of findings) console.log(formatFinding(f));
    const notRun =
      unavailable.length > 0 ? `; ${unavailable.length} check(s) could not run — not a pass` : "";
    console.log(
      `guardrails verify: ${errors} error(s), ${warnings} warning(s) in ${paths.join(" ")}; ${overrides.length} override(s), ${overrides.filter((o) => o.reason.status === "missing").length} without a reason${notRun}`,
    );
    if (errors > 0) {
      if (findings.some((f) => f.severity === "error" && !isRustFinding(f)))
        console.log(
          "Fix these, or suppress a genuine false positive with a justified comment on the line above:\n  // ast-grep-ignore: <rule-id> -- <why this is legitimate>",
        );
      if (findings.some(isRustFinding)) console.log(RUST_SUPPRESS_HINT);
    }
  }
  if (hasErrors(findings)) return 1;
  return unavailable.length > 0 ? 2 : 0;
}
