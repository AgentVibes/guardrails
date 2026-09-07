import { AstGrepConfigError, scanFindings } from "./astGrep.js";
import { type Finding, formatFinding, hasErrors } from "./findings.js";
import { rulesConfig } from "./packagePaths.js";
import { driftMessage, presetDrift, presetEnforced } from "./presetDrift.js";
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
  return dropScopeExempt(findings, scopePatterns(cwd), scopeExemptRuleIds());
}

export function runVerify(targets: string[], json: boolean): number {
  const paths = targets.length > 0 ? targets : ["."];

  // Preset drift is checked FIRST (is-9c7a78d7): a repo running its own biome
  // config is not being linted by the thing this gate reports on, so a finding
  // count from it means less than it looks. Enforcement is opt-in per repo
  // (`[biome] preset = "enforced"`) while epic is-a70a5963 migrates the 37
  // configs; unenforced, the drift is still SAID — silence is what let 37
  // configs exist.
  const drift = presetDrift(process.cwd());
  if (drift.length > 0) {
    const message = driftMessage(drift);
    if (presetEnforced(process.cwd())) {
      console.error(`guardrails verify: ${message}`);
      return 2;
    }
    if (!json) {
      console.log(
        `note: ${message}\n  Not gated here yet — add [biome] preset = "enforced" to .agentvibes/project.toml once this repo is migrated.`,
      );
    }
  }

  // Both manifest sections are resolved here so a config the gate cannot honour
  // exits 2 with the reason — never a stack trace, and never silently dropped.
  let findings: Finding[];
  try {
    findings = collectVerifyFindings(paths, severityRaiseArgs(process.cwd()));
  } catch (err) {
    if (
      err instanceof SeverityConfigError ||
      err instanceof ScreenScopeError ||
      err instanceof AstGrepConfigError
    ) {
      console.error(`guardrails verify: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  if (json) {
    console.log(
      JSON.stringify({ command: "verify", targets: paths, errors, warnings, findings }, null, 2),
    );
  } else {
    for (const f of findings) console.log(formatFinding(f));
    console.log(
      `guardrails verify: ${errors} error(s), ${warnings} warning(s) in ${paths.join(" ")}`,
    );
    if (errors > 0) {
      console.log(
        "Fix these, or suppress a genuine false positive with a justified comment on the line above:\n  // ast-grep-ignore: <rule-id> -- <why this is legitimate>",
      );
    }
  }
  return hasErrors(findings) ? 1 : 0;
}
