import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { scan } from "./astGrep.js";
import type { Finding } from "./findings.js";
import { structureConfig } from "./packagePaths.js";

// Ported from defensive-errors check-structure.sh: ast-grep cannot count
// matches per file or measure a node's line span in a rule, so this wraps the
// `component-decl` marker rule and synthesises three findings from the per-file
// grouping. Findings anchor at the component's DECLARATION line — that anchor
// is what makes the size rule a true ratchet under verify-diff: it gates
// components that are born too long, not existing ones someone edited inside.
//
// D2: components over 120 lines are errors, over 90 warnings.
// D3: strict one component per file.

const MAX_LINES = Number(
  process.env.GUARDRAILS_MAX_COMPONENT_LINES ?? process.env.DE_MAX_COMPONENT_LINES ?? 120,
);
const WARN_LINES = Number(
  process.env.GUARDRAILS_WARN_COMPONENT_LINES ?? process.env.DE_WARN_COMPONENT_LINES ?? 90,
);

const IGNORE_DIRECTIVE = "ast-grep-ignore";

/** Honours a suppression comment on the line directly above the declaration. */
function suppressed(file: string, line: number, rule: string): boolean {
  let prev: string | undefined;
  try {
    prev = readFileSync(file, "utf8").split("\n")[line - 2];
  } catch {
    return false;
  }
  if (prev === undefined) return false;
  const dirAt = prev.indexOf(IGNORE_DIRECTIVE);
  return dirAt >= 0 && prev.indexOf(rule, dirAt) > dirAt;
}

export function structureFindings(targets: string[]): Finding[] {
  const decls = scan(structureConfig, targets).filter((r) => r.ruleId === "component-decl");

  const byFile = new Map<string, typeof decls>();
  for (const d of decls) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }

  const findings: Finding[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.startLine - b.startLine);
    let folderReported = false;
    list.forEach((decl, idx) => {
      const name = decl.metaText("N") ?? "?";
      if (idx > 0 && !suppressed(file, decl.startLine, "react-multi-component")) {
        findings.push({
          rule: "react-multi-component",
          severity: "error",
          file,
          line: decl.startLine,
          message: `${name} is component #${idx + 1} in ${basename(file)} — one component per file. Move it to its own file next to this one and import it.`,
          source: "structure",
        });
        // A file with parts belongs in a folder. Chained off multi-component on
        // purpose: single cohesive components never need a folder, so the same
        // signal drives both remediations.
        const parent = basename(dirname(file));
        if (
          !folderReported &&
          (parent === "components" || parent === "pages" || parent === "src") &&
          !suppressed(file, decl.startLine, "react-component-needs-folder")
        ) {
          folderReported = true;
          findings.push({
            rule: "react-component-needs-folder",
            severity: "error",
            file,
            line: decl.startLine,
            message: `${basename(file)} holds several components and sits directly in ${parent}/ — move the family into its own folder (entry file named after the folder, one file per component, no barrel index.ts).`,
            source: "structure",
          });
        }
      }
      if (suppressed(file, decl.startLine, "react-component-too-long")) return;
      if (decl.spanLines > MAX_LINES) {
        findings.push({
          rule: "react-component-too-long",
          severity: "error",
          file,
          line: decl.startLine,
          message: `${name} spans ${decl.spanLines} lines (max ${MAX_LINES}). Split it — extract the list item, each section, and each state branch into their own components.`,
          source: "structure",
        });
      } else if (decl.spanLines > WARN_LINES) {
        findings.push({
          rule: "react-component-too-long",
          severity: "warning",
          file,
          line: decl.startLine,
          message: `${name} spans ${decl.spanLines} lines (warn over ${WARN_LINES}, max ${MAX_LINES}). Split it — extract the list item, each section, and each state branch into their own components.`,
          source: "structure",
        });
      }
    });
  }
  return findings;
}
