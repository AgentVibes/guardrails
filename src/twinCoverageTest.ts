import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import { rulesDir } from "./packagePaths.js";

// The mechanical half of is-fc8916f7. `non-exhaustive-match` was blind to
// `.tsx` for months and nobody noticed, because a rule that cannot match the
// language it is pointed at reports exactly what a correct rule with nothing to
// find reports: zero. `testRules.ts` catches that for every rule it asserts;
// this catches the rule that was never written at all.
//
// ast-grep's `typescript` and `tsx` languages are DISJOINT (the mechanism, and
// the three rejected alternatives, are written out in `catch-empty-tsx.yml`), so
// full coverage of a `.ts`/`.tsx` codebase means TWO rule ids per rule. This
// file asserts that every rule family has both arms, in both directions, unless
// the family has an explicit entry below saying why it does not.
//
// A family is the id with a trailing `-ts` / `-tsx` stripped, NOT the id itself.
// Keying on the id would demand `demo-mode-by-default-ts-tsx`: that pair is
// spelled the other way round (`demo-mode-by-default` is the tsx arm and
// `demo-mode-by-default-ts` the .ts one) and is complete as it stands.

type Language = "typescript" | "tsx";

interface Rule {
  file: string;
  id: string;
  language: Language;
  /** Top-level YAML blocks, keyed by their column-0 key. */
  blocks: Map<string, string>;
}

/**
 * Why a family has only one arm.
 *
 * `impossible` — the missing arm could never report: the rule matches JSX nodes
 * that do not exist in the other grammar, or its `files:` globs name only files
 * of one extension. These need no issue; writing the arm would add a rule that
 * is dead by construction.
 *
 * `gap` — the missing arm COULD report and simply does not exist yet. Every
 * entry carries what it was measured at and the issue that owns the decision.
 * Adding one of these is a change to what consumer repos see, not a chore.
 */
interface Exception {
  /** The language that IS covered; the other arm is the one missing. */
  only: Language;
  kind: "impossible" | "gap";
  why: string;
}

const EXCEPTIONS: Record<string, Exception> = {
  // ── JSX-node rules: the pattern cannot be spelled in a .ts grammar ──────
  "classname-not-composed": {
    only: "tsx",
    kind: "impossible",
    why: "matches a `jsx_attribute`; there are none in .ts",
  },
  "classname-visual-identity": {
    only: "tsx",
    kind: "impossible",
    why: "matches a `jsx_attribute`; there are none in .ts",
  },
  "inline-map-row": {
    only: "tsx",
    kind: "impossible",
    why: "matches `jsx_element` / `jsx_expression` inside a `.map()`; there are none in .ts",
  },
  "jsx-cond-and": {
    only: "tsx",
    kind: "impossible",
    why: "the whole rule is `$COND && <JSX/>` patterns",
  },
  "jsx-ternary": {
    only: "tsx",
    kind: "impossible",
    why: "requires a JSX consequence or alternative, by its `is-jsx` util",
  },

  // ── `files:`-scoped rules: the missing arm would have no file to read ───
  "direct-store-import": {
    only: "tsx",
    kind: "impossible",
    why: "`files:` is `**/*.tsx` only",
  },
  "screen-file-styling": {
    only: "tsx",
    kind: "impossible",
    why: "`files:` is `**/*.screen.tsx` only (and it matches a `jsx_attribute`)",
  },
  "view-file-logic": {
    only: "tsx",
    kind: "impossible",
    why: "`files:` is `**/*.view.tsx` only",
  },
  "view-imports-store": {
    only: "tsx",
    kind: "impossible",
    why: "`files:` is `**/*.view.tsx` only",
  },

  // ── React-runtime rules: the construct only exists in a component ───────
  "missing-observer": {
    only: "tsx",
    kind: "impossible",
    why: "asks whether a COMPONENT reading a store is wrapped in `observer()`; a .ts module is not a component",
  },
  "mobx-effect-observable-dep": {
    only: "tsx",
    kind: "impossible",
    why: "matches `useEffect(cb, [deps])` in a component; a .ts custom hook has no store to depend on in this shape",
  },
  "mobx-effect-store-write": {
    only: "tsx",
    kind: "impossible",
    why: "matches a store write inside a component's `useEffect`",
  },
  "mobx-usestate-from-store": {
    only: "tsx",
    kind: "impossible",
    why: "matches `useState(store.field)` — seeding component state from a store",
  },

  // ── Real gaps. Measured, tracked, not silently green. ───────────────────
  "discriminator-ternary": {
    only: "tsx",
    kind: "gap",
    why: "stands down when a branch is JSX, so what it matches is a plain ternary that .ts can hold too; measured 0 in .ts across the five consumer repos 2026-09-06 (is-760b0b4b)",
  },
  "match-bool-to-null": {
    only: "tsx",
    kind: "gap",
    why: "the `match(cond).with(true, …).with(false, () => null)` pattern does not require JSX; measured 0 in .ts across the five consumer repos 2026-09-06 (is-760b0b4b)",
  },
  "hardcoded-url-in-component": {
    only: "tsx",
    kind: "gap",
    why: "its `files:` globs already name `**/components/**/*.ts` and `**/screens/**/*.ts`, which `language: tsx` makes dead lines; measured 0 in .ts across the five consumer repos 2026-09-06 (is-760b0b4b)",
  },
  "ui-imports-app-store": {
    only: "tsx",
    kind: "gap",
    why: "`files:` names whole directories, so the .ts files in them are unscanned; measured 0 in .ts across the five consumer repos 2026-09-06, but this rule is error-tier and its .ts arm can turn a consumer's CI red — that is a decision, not a chore (is-760b0b4b)",
  },
};

/**
 * Keys compared between the two arms of a family.
 *
 * `severity` is the one that must be byte-identical: the same code reported as
 * a warning in `.ts` and an error in `.tsx` is a gate that depends on a file
 * extension, and nothing else in this package works that way.
 *
 * `files` and `ignores` are compared with `.tsx` folded to `.ts`, because they
 * SHOULD differ — the `.ts` arm ignores `**\/*.test.ts` and the tsx arm
 * `**\/*.test.tsx`, naming the same intent. Folded, a real divergence (one arm
 * scoped to a directory the other is not) still shows.
 *
 * `rule` and `utils` are deliberately NOT compared. The twin comments say "keep
 * the rule block IDENTICAL" and that is the right default, but it is a rule of
 * thumb rather than an invariant: `store-context-provider-tsx` carries an extra
 * `jsx_opening_element` arm for `<XxxStoreContext.Provider>`, which cannot be
 * spelled in the `.ts` grammar at all. Asserting identity here would force that
 * correct rule to be wrong.
 */
const MUST_MATCH = ["severity"] as const;
const MUST_MATCH_FOLDED = ["files", "ignores"] as const;

/** Erase the one difference two arms are SUPPOSED to have: the extension. */
function foldExtensions(block: string): string {
  return block.replace(/\.tsx\b/g, ".ts");
}

/** Split a rule file into its column-0 `key:` blocks, dropping column-0 comments. */
function topLevelBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let key: string | undefined;
  let buf: string[] = [];
  const flush = (): void => {
    if (key !== undefined) blocks.set(key, buf.join("\n").trimEnd());
    key = undefined;
    buf = [];
  };
  for (const line of text.split("\n")) {
    const head = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (head?.[1] !== undefined) {
      flush();
      key = head[1];
      buf = [head[2] ?? ""];
    } else if (line.startsWith("#")) {
      // A column-0 comment is provenance prose. It ENDS the block above it —
      // without this, the header comments between `id:` and `language:` were
      // swallowed into the id and every family name came out as an essay.
      flush();
    } else if (key !== undefined) {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

function loadRules(): { rules: Rule[]; errors: string[] } {
  const errors: string[] = [];
  const rules: Rule[] = [];
  for (const file of readdirSync(rulesDir)
    .filter((f) => f.endsWith(".yml"))
    .sort()) {
    const blocks = topLevelBlocks(readFileSync(join(rulesDir, file), "utf8"));
    const id = blocks.get("id")?.trim();
    const language = blocks.get("language")?.trim();
    if (id === undefined || id === "") {
      errors.push(`${file}: no top-level \`id:\``);
      continue;
    }
    if (language !== "typescript" && language !== "tsx") {
      errors.push(
        `${file}: \`language:\` is ${language ?? "(absent)"}, expected typescript or tsx`,
      );
      continue;
    }
    if (id !== file.replace(/\.yml$/, "")) {
      errors.push(
        `${file}: id \`${id}\` does not match the filename — ast-grep reports the id, so the two must agree`,
      );
    }
    rules.push({ file, id, language, blocks });
  }
  return { rules, errors };
}

/** The id with a trailing `-ts` / `-tsx` stripped. */
function familyOf(id: string): string {
  return id.replace(/-tsx$/, "").replace(/-ts$/, "");
}

function main(): number {
  console.log("== rule twin coverage ==");
  const { rules, errors } = loadRules();
  let fail = errors.length > 0;
  for (const e of errors) console.log(`FAIL ${e}`);

  const families = new Map<string, { typescript?: Rule; tsx?: Rule }>();
  for (const r of rules) {
    const fam = families.get(familyOf(r.id)) ?? {};
    const seen = fam[r.language];
    if (seen !== undefined) {
      console.log(
        `FAIL ${familyOf(r.id)}: two \`language: ${r.language}\` arms — ${seen.file} and ${r.file}`,
      );
      fail = true;
    }
    fam[r.language] = r;
    families.set(familyOf(r.id), fam);
  }

  const gaps: string[] = [];
  for (const [name, arms] of [...families].sort()) {
    const exception = EXCEPTIONS[name];
    const missing =
      arms.typescript === undefined ? "typescript" : arms.tsx === undefined ? "tsx" : undefined;

    if (missing === undefined) {
      if (exception !== undefined) {
        console.log(
          `FAIL ${name}: both arms exist, but EXCEPTIONS still lists it as ${exception.only}-only — delete the stale entry`,
        );
        fail = true;
      }
      // Both arms present: they must agree on what they report.
      const a = arms.typescript;
      const b = arms.tsx;
      if (a !== undefined && b !== undefined) {
        const drifted = [
          ...MUST_MATCH.filter((k) => (a.blocks.get(k) ?? "") !== (b.blocks.get(k) ?? "")),
          ...MUST_MATCH_FOLDED.filter(
            (k) => foldExtensions(a.blocks.get(k) ?? "") !== foldExtensions(b.blocks.get(k) ?? ""),
          ),
        ];
        if (drifted.length > 0) {
          console.log(
            `FAIL ${name}: ${a.file} and ${b.file} disagree on ${drifted.join(", ")} — twins are one rule wearing two ids`,
          );
          fail = true;
        } else {
          console.log(`  ok  ${name}: ${a.id} + ${b.id}, same severity and same scope`);
        }
      }
      continue;
    }

    const covered = missing === "tsx" ? "typescript" : "tsx";
    if (exception === undefined) {
      console.log(
        `FAIL ${name}: \`language: ${covered}\` only — no ${missing} arm and no EXCEPTIONS entry. ` +
          `ast-grep's languages are disjoint, so this rule is blind to every .${missing === "tsx" ? "tsx" : "ts"} file. ` +
          `Write ${name}${missing === "tsx" ? "-tsx" : "-ts"}.yml, or add an entry saying why it cannot fire there.`,
      );
      fail = true;
      continue;
    }
    if (exception.only !== covered) {
      console.log(
        `FAIL ${name}: EXCEPTIONS says ${exception.only}-only but the rule on disk is ${covered}-only`,
      );
      fail = true;
      continue;
    }
    match(exception.kind)
      .with("gap", () => {
        gaps.push(`${name} (no .${missing === "tsx" ? "tsx" : "ts"} arm): ${exception.why}`);
        console.log(`  ok  ${name}: ${covered}-only, KNOWN GAP — ${exception.why}`);
      })
      .with("impossible", () => {
        console.log(`  ok  ${name}: ${covered}-only — ${exception.why}`);
      })
      .exhaustive();
  }

  if (gaps.length > 0) {
    console.log("");
    console.log(`known language gaps (${gaps.length}) — tracked, not fixed:`);
    for (const g of gaps) console.log(`  · ${g}`);
  }

  console.log("");
  if (fail) {
    console.error("twin coverage assertions FAILED");
    return 1;
  }
  console.log(`all ${families.size} rule families accounted for`);
  return 0;
}

process.exit(main());
