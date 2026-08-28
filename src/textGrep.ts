import { readFileSync } from "node:fs";
import { collectFiles } from "./fileWalk.js";
import type { Finding } from "./findings.js";

interface TextRule {
  id: string;
  pattern: RegExp;
  exts: string[];
  excludePath: RegExp;
  message: string;
}

// Ported from defensive-errors scan.sh — patterns that don't express cleanly
// in ast-grep. Warning tier always: text greps never block a gate.
const TEXT_RULES: TextRule[] = [
  {
    id: "ts-suppression",
    pattern: /@ts-nocheck|@ts-ignore|@ts-expect-error/,
    exts: [".ts", ".tsx"],
    excludePath: /__tests__/,
    message:
      "TypeScript suppression comment hides a real type error. Fix the type at the source instead.",
  },
  {
    id: "jsx-cond-and-textgrep",
    pattern: /\{[A-Za-z_!][A-Za-z0-9_.!?]* && </,
    exts: [".tsx", ".jsx"],
    excludePath: /__tests__|\/ai-elements\//,
    message:
      "JSX `{cond && <...>}` silently drops the !cond branch. Use match(cond).with(true, ...).with(false, () => null).exhaustive() so both arms are visible.",
  },
];

export function textGrepFindings(targets: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const rule of TEXT_RULES) {
    for (const file of collectFiles(targets, rule.exts)) {
      if (rule.excludePath.test(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && rule.pattern.test(line)) {
          findings.push({
            rule: rule.id,
            severity: "warning",
            file,
            line: i + 1,
            message: rule.message,
            source: "text-grep",
          });
        }
      }
    }
  }
  return findings;
}
