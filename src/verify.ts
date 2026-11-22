import { AstGrepConfigError, scanFindings } from "./astGrep.js";
import { type Finding, formatFinding, hasErrors } from "./findings.js";
import { dropJsxSuppressed } from "./jsxSuppress.js";
import { OverrideConfigError } from "./overrideDeclarations.js";
import { collectOverrides, type Override } from "./overrides.js";
import { rulesConfig } from "./packagePaths.js";
import { driftMessage, presetDrift } from "./presetDrift.js";
import { type RunCollector, scopeOf } from "./record/record.js";
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

export function runVerify(targets: string[], json: boolean, run: RunCollector): number {
  const paths = targets.length > 0 ? targets : ["."];
  const scope = scopeOf(paths);

  // Preset drift is checked FIRST (is-9c7a78d7): a repo running its own biome
  // config is not being linted by the thing this gate reports on, so a finding
  // count from it means less than it looks. It gates in every repo.
  const drift = presetDrift(process.cwd());
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
  try {
    findings = collectVerifyFindings(paths, severityRaiseArgs(process.cwd()));
    // The overrides inventory (overrides.ts) is `verify`-only: a missing
    // reason is a warning for the repo to see, not something the per-edit
    // hooks or the diff ratchet should re-report on every change.
    const report = collectOverrides(process.cwd(), paths);
    overrides = report.overrides;
    findings = [...findings, ...report.findings];
    run.findings = { status: "measured", scope, data: { tiers: "all", list: findings } };
    run.overrides = { status: "measured", scope, data: overrides };
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

  if (json) {
    console.log(
      JSON.stringify(
        { command: "verify", targets: paths, errors, warnings, findings, overrides },
        null,
        2,
      ),
    );
  } else {
    for (const f of findings) console.log(formatFinding(f));
    console.log(
      `guardrails verify: ${errors} error(s), ${warnings} warning(s) in ${paths.join(" ")}; ${overrides.length} override(s), ${overrides.filter((o) => o.reason.status === "missing").length} without a reason`,
    );
    if (errors > 0) {
      console.log(
        "Fix these, or suppress a genuine false positive with a justified comment on the line above:\n  // ast-grep-ignore: <rule-id> -- <why this is legitimate>",
      );
    }
  }
  return hasErrors(findings) ? 1 : 0;
}
