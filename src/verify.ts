import { scanFindings } from "./astGrep.js";
import { type Finding, formatFinding, hasErrors } from "./findings.js";
import { rulesConfig } from "./packagePaths.js";
import { structureFindings } from "./structure.js";
import { textGrepFindings } from "./textGrep.js";

export function collectVerifyFindings(targets: string[]): Finding[] {
  return [
    ...scanFindings(rulesConfig, targets),
    ...textGrepFindings(targets),
    ...structureFindings(targets),
  ];
}

export function runVerify(targets: string[], json: boolean): number {
  const paths = targets.length > 0 ? targets : ["."];
  const findings = collectVerifyFindings(paths);
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
