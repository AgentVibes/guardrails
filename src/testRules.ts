import { scan } from "./astGrep.js";
import { fixturesDir, rulesConfig } from "./packagePaths.js";

// Fixture harness for the bundled ast-grep rules — port of defensive-errors
// test-rules.sh. The iron rule from ast-grep's own maintainers: never trust an
// unexecuted rule. A rule that silently failed to load, or whose `files:` glob
// excluded the fixture, produces exactly the same output as a rule that
// correctly found nothing — so "no unexpected matches" is not a passing test.
//
// Hence every asserted rule runs in BOTH directions, and the positive
// assertion is an exact count that hard-fails at zero. Scanning goes through
// sgconfig.yml rather than per-rule invocation, so a passing run also proves
// each rule is WIRED — a rule `ruleDirs` never picked up reports zero and
// fails its positive assertion.

interface Expectation {
  rule: string;
  badSuffix: string;
  hits: number;
  goodSuffix: string;
}

const EXPECTATIONS: Expectation[] = [
  {
    rule: "missing-observer",
    badSuffix: "missing-observer/bad.tsx",
    hits: 9,
    goodSuffix: "missing-observer/good.tsx",
  },
  {
    rule: "inline-map-row",
    badSuffix: "inline-map-row/bad.tsx",
    hits: 6,
    goodSuffix: "inline-map-row/good.tsx",
  },
  {
    rule: "direct-store-import",
    badSuffix: "direct-store-import/bad.tsx",
    hits: 6,
    goodSuffix: "direct-store-import/good.tsx",
  },
  {
    rule: "view-imports-store",
    badSuffix: "view-imports-store/bad.view.tsx",
    hits: 5,
    goodSuffix: "view-imports-store/good.view.tsx",
  },
  {
    rule: "ui-imports-app-store",
    badSuffix: "ui-imports-app-store/src/ui/bad.tsx",
    hits: 5,
    goodSuffix: "ui-imports-app-store/src/ui/good.tsx",
  },
];

// A file that is deliberately out of scope — same offending code as the bad
// fixture, sitting where an `ignores:` glob excludes it. Pins the glob: drop
// the ignore and this starts reporting.
const EXPECT_ZERO: { rule: string; suffix: string; why: string }[] = [
  {
    rule: "direct-store-import",
    suffix: "direct-store-import/showcase/ignored.tsx",
    why: "showcase/ is an ignores: glob",
  },
];

function main(): number {
  const rows = scan(rulesConfig, [fixturesDir]);
  const count = (rule: string, suffix: string): number =>
    rows.filter((r) => r.ruleId === rule && r.file.endsWith(suffix)).length;

  let fail = false;
  console.log("== ast-grep rule fixtures ==");

  for (const e of EXPECTATIONS) {
    const gotBad = count(e.rule, e.badSuffix);
    const gotGood = count(e.rule, e.goodSuffix);
    if (gotBad === 0) {
      // The failure this harness exists to make loud: silence is NOT a pass.
      console.log(
        `FAIL ${e.rule}: 0 hits on ${e.badSuffix} — rule did not load, its files: glob excluded the fixture, or it matches nothing`,
      );
      fail = true;
    } else if (gotBad !== e.hits) {
      console.log(`FAIL ${e.rule}: ${e.badSuffix} expected ${e.hits} hits, got ${gotBad}`);
      fail = true;
    } else {
      console.log(`  ok  ${e.rule}: ${e.badSuffix} → ${gotBad} hits (expected ${e.hits})`);
    }
    if (gotGood !== 0) {
      console.log(
        `FAIL ${e.rule}: ${e.goodSuffix} expected 0 hits, got ${gotGood} (false positives)`,
      );
      for (const r of rows.filter((x) => x.ruleId === e.rule && x.file.endsWith(e.goodSuffix))) {
        console.log(`        ${r.file}:${r.startLine}`);
      }
      fail = true;
    } else {
      console.log(`  ok  ${e.rule}: ${e.goodSuffix} → 0 hits`);
    }
  }

  for (const z of EXPECT_ZERO) {
    const got = count(z.rule, z.suffix);
    if (got !== 0) {
      console.log(`FAIL ${z.rule}: ${z.suffix} expected 0 hits (${z.why}), got ${got}`);
      fail = true;
    } else {
      console.log(`  ok  ${z.rule}: ${z.suffix} → 0 hits (${z.why})`);
    }
  }

  console.log("");
  if (fail) {
    console.error("fixture assertions FAILED");
    return 1;
  }
  console.log("all fixture assertions passed");
  return 0;
}

process.exit(main());
