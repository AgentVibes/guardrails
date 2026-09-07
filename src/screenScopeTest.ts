import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";
import { scopeExemptRuleIds } from "./screenScope.js";

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
// The canonical async union the kit publishes — what `no-local-kit-clone` tells
// every other repo to import instead of redeclaring.
const KIT_RESOURCE =
  "export type Resource<T> =\n" +
  '  | { kind: "idle" }\n' +
  '  | { kind: "loading" }\n' +
  '  | { kind: "ready"; value: T }\n' +
  '  | { kind: "error"; message: string };\n';
// Nothing to do with the kit: pins that the scope is one rule wide.
const EMPTY_CATCH = "export const go = () => {\n  try { work() } catch (e) { }\n};\n";
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

// 0 — every registered scope has at least one rule carrying its marker, so no
// scope in the registry is inert. A scope with an empty exempt set filters
// nothing and would pass every other check below while doing nothing at all.
const exempt = scopeExemptRuleIds();
for (const [scope, ids] of exempt) {
  if (ids.size === 0) {
    fail(`no bundled rule declares \`appliesTo: not-${scope}\` — that scope would filter nothing`);
  } else {
    console.log(`  ok  screen-scope: ${ids.size} rule(s) declare appliesTo: not-${scope}`);
  }
}
if (exempt.get("screens")?.has("direct-store-import") !== true) {
  fail("direct-store-import lost its `appliesTo: not-screens` marker");
}
if (exempt.get("kit-source")?.has("no-local-kit-clone") !== true) {
  fail("no-local-kit-clone lost its `appliesTo: not-kit-source` marker");
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

// 5 — the second scope, kit-source: `@agentvibes/kit` holds the canonical
// Resource<T>, and `no-local-kit-clone` (error tier) fires on it unless the
// repo declares the tree. Both directions, because a scope that swallows the
// rule everywhere would pass the declared half on its own.
{
  const root = mkdtempSync(join(tmpdir(), "guardrails-kitsrc-"));
  try {
    mkdirSync(join(root, "src", "resource"), { recursive: true });
    mkdirSync(join(root, ".agentvibes"), { recursive: true });
    writeFileSync(join(root, "src", "resource", "resource.ts"), KIT_RESOURCE);
    writeFileSync(join(root, ".agentvibes", "project.toml"), "");
    const undeclared = verify(root);
    if (!undeclared.out.includes("no-local-kit-clone")) {
      fail("without [verify] kit_source the canonical Resource<T> must still be flagged");
    } else {
      console.log("  ok  screen-scope: undeclared repo still fires no-local-kit-clone");
    }

    writeFileSync(join(root, ".agentvibes", "project.toml"), '[verify]\nkit_source = "^src/"\n');
    const declared = verify(root);
    if (declared.out.includes("no-local-kit-clone")) {
      fail("a declared kit source must not be flagged by no-local-kit-clone");
    } else {
      console.log("  ok  screen-scope: the kit's own Resource<T> stops firing once declared");
    }

    // The narrowness half: a rule that has nothing to do with kit-source keeps
    // firing inside the declared tree.
    writeFileSync(join(root, "src", "resource", "swallow.ts"), EMPTY_CATCH);
    const still = verify(root);
    if (!still.out.includes("catch-empty")) {
      fail("kit_source must scope no-local-kit-clone only — catch-empty still applies");
    } else {
      console.log("  ok  screen-scope: kit_source scopes one rule, not the whole tree");
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
