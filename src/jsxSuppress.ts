import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Finding } from "./findings.js";

// JSX suppressions (found while migrating gramforge/gramforge, is-18ff62fb).
//
// ast-grep's own `// ast-grep-ignore: <rule> -- <why>` is a line comment on the
// preceding line. That works everywhere in `.ts`, and in the parts of a `.tsx`
// file that are ordinary code — but NOT inside JSX children, where `//` is not
// a comment at all. It is text, and it renders. The migration nearly shipped
//
//   </head>
//   // ast-grep-ignore: classname-not-composed -- ...
//   <body className={...}>
//
// into a page, where the comment would have appeared on screen. The correct
// JSX form is `{/* ... */}`, and ast-grep does not recognise it: measured on a
// two-file fixture, `{/* ast-grep-ignore: classname-not-composed -- ... */}`
// suppressed nothing.
//
// So findings inside JSX had NO usable suppression at all. Every `.tsx` rule
// that fires on markup — classname-not-composed, inline-map-row,
// jsx-cond-and-ternary — was unsuppressable, which for an adopting repo means
// the gate cannot be made green except by changing code the migration was not
// supposed to touch.
//
// This closes that: guardrails drops a finding when the line above it carries
// the same directive written the way JSX requires. The `//` form is left
// entirely to ast-grep — this only ADDS the bracketed form, and only for the
// rule it names, so it can never suppress more than the line comment would.

/** `{/* ast-grep-ignore: <rule-id> -- <why> *​/}`, the JSX-legal spelling. */
const JSX_IGNORE = /^\s*\{\s*\/\*\s*ast-grep-ignore:\s*([A-Za-z0-9_-]+)\b([\s\S]*?)\*\/\s*\}\s*$/;

/**
 * A reason is required, exactly as the line-comment form requires one: the
 * directive exists to record WHY a rule does not apply, and a bare id is a
 * silent exemption. Without `--` the suppression does not apply and the
 * finding stands.
 */
function suppressesRule(line: string, rule: string): boolean {
  const m = JSX_IGNORE.exec(line);
  if (m === null) return false;
  if (m[1] !== rule) return false;
  return /--\s*\S/.test(m[2] ?? "");
}

const cache = new Map<string, string[]>();

function fileLines(path: string, cwd: string): string[] {
  const key = isAbsolute(path) ? path : join(cwd, path);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let lines: string[];
  try {
    lines = readFileSync(key, "utf8").split("\n");
  } catch {
    // ast-grep-ignore: catch-empty -- a finding whose file cannot be re-read (deleted between scan and filter, or a synthetic path) keeps the finding; treating unreadable as "suppressed" would drop real findings
    lines = [];
  }
  cache.set(key, lines);
  return lines;
}

/** Drop findings whose preceding line carries the JSX-form ignore for that rule. */
export function dropJsxSuppressed(findings: readonly Finding[], cwd: string): Finding[] {
  cache.clear();
  return findings.filter((f) => {
    if (!f.file.endsWith(".tsx") && !f.file.endsWith(".jsx")) return true;
    const lines = fileLines(f.file, cwd);
    const above = lines[f.line - 2];
    if (above === undefined) return true;
    return !suppressesRule(above, f.rule);
  });
}
