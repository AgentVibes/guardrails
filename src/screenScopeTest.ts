import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { screenExemptRuleIds } from "./screenScope.js";

// `[verify] screens` — the repo says where its screens are; the canon says which
// rules do not apply there (is-7067a0b8). Four directions, all executed:
//   1. with no declaration, a screen still fires — absent key, absent behaviour
//   2. with the declaration, the screen stops firing
//   3. the LEAF COMPONENT still fires either way — the half that has to keep
//      working, or the scope is a blanket off-switch wearing a narrow name
//   4. an unusable pattern fails loudly rather than being dropped
//
// Plus the one that stops the whole mechanism being inert: at least one bundled
// rule must actually carry the marker. A scope with an empty exempt set filters
// nothing and would pass 1, 3 and 4 while doing nothing at all.

// The §8 screen shape: the screen owns its page store, so it must import the class.
const SCREEN =
  'import { rootStore } from "../stores/rootStore";\n' +
  'import { GalleryPageStore } from "../stores/GalleryPageStore";\n' +
  'export const GalleryScreen = () => new GalleryPageStore(rootStore, "slug");\n';
// A leaf reaching past the boundary — banned everywhere, screens included.
const LEAF =
  'import { galleryStore } from "../stores/gallery";\n' +
  "export const Row = () => galleryStore.title;\n";

function fixture(screensKey: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "guardrails-screens-"));
  mkdirSync(join(root, "src", "screens"), { recursive: true });
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, ".agentvibes"), { recursive: true });
  writeFileSync(join(root, "src", "screens", "GalleryScreen.tsx"), SCREEN);
  writeFileSync(join(root, "src", "components", "Row.tsx"), LEAF);
  writeFileSync(
    join(root, ".agentvibes", "project.toml"),
    screensKey === undefined ? "" : `[verify]\nscreens = "${screensKey}"\n`,
  );
  return root;
}

function verify(cwd: string): { status: number; out: string } {
  const res = spawnSync("node", [join(packageRoot, "dist", "cli.js"), "verify", "src"], {
    cwd,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

let failed = 0;
const fail = (m: string) => {
  console.error(`FAIL screen-scope: ${m}`);
  failed++;
};

// 0 — the marker exists, so the mechanism is not inert
const exempt = screenExemptRuleIds();
if (!exempt.has("direct-store-import")) {
  fail("no bundled rule declares `appliesTo: not-screens` — the scope would filter nothing");
} else {
  console.log(`  ok  screen-scope: ${exempt.size} rule(s) declare appliesTo: not-screens`);
}

// 1 — no declaration, no change
{
  const root = fixture(undefined);
  try {
    const { out } = verify(root);
    if (!out.includes("GalleryScreen.tsx")) {
      fail(
        "without [verify] screens the screen must still be flagged (absent key, absent behaviour)",
      );
    } else {
      console.log("  ok  screen-scope: undeclared repo scans exactly as before");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 2 and 3 — the screen is scoped out, the leaf is not
{
  const root = fixture("^src/screens/");
  try {
    const { out } = verify(root);
    if (out.includes("GalleryScreen.tsx")) {
      fail("a declared screen must not be flagged by direct-store-import");
    } else {
      console.log("  ok  screen-scope: the §8 screen shape stops firing once declared");
    }
    if (!out.includes("Row.tsx")) {
      fail("the leaf component MUST still fire — scoping screens is not an off-switch");
    } else {
      console.log("  ok  screen-scope: the leaf component still fires (the scope is narrow)");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4 — an unusable pattern is refused, not dropped
{
  const root = fixture("^src/screens/[");
  try {
    const { status, out } = verify(root);
    if (status !== 2 || !out.includes("not a valid regular expression")) {
      fail(`a malformed [verify] screens must exit 2 with a reason, got exit ${status}`);
    } else {
      console.log("  ok  screen-scope: a malformed pattern fails loudly (exit 2)");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`screen-scope: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("screen-scope: all checks passed");
