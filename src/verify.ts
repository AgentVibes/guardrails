import { scanFindings } from "./astGrep.js";
import { type Finding, formatFinding, hasErrors } from "./findings.js";
import { rulesConfig } from "./packagePaths.js";
import {
  dropScreenExempt,
  ScreenScopeError,
  screenExemptRuleIds,
  screensPattern,
} from "./screenScope.js";
import { SeverityConfigError, severityRaiseArgs } from "./severity.js";
import { structureFindings } from "./structure.js";
import { textGrepFindings } from "./textGrep.js";

export function collectVerifyFindings(targets: string[], severityArgs: string[] = []): Finding[] {
  const findings = [
    ...scanFindings(rulesConfig, targets, severityArgs),
    ...textGrepFindings(targets),
    ...structureFindings(targets),
  ];
  // Applied HERE rather than in `runVerify`, so verify-diff and the hooks get
  // the same scoping: a screen that is legal under `verify` must not be gated
  // by `verify-diff` on the same line.
  return dropScreenExempt(findings, screensPattern(process.cwd()), screenExemptRuleIds());
}

export function runVerify(targets: string[], json: boolean): number {
  const paths = targets.length > 0 ? targets : ["."];
  // Both manifest sections are resolved here so a config the gate cannot honour
  // exits 2 with the reason — never a stack trace, and never silently dropped.
  let findings: Finding[];
  try {
    findings = collectVerifyFindings(paths, severityRaiseArgs(process.cwd()));
  } catch (err) {
    if (err instanceof SeverityConfigError || err instanceof ScreenScopeError) {
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
