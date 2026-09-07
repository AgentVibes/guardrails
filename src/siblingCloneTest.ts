import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./packagePaths.js";

// The gate's sibling-repo clone, run for real (is-8774fe0e). A self-hosted
// runner keeps its _work directory between jobs and `actions/checkout` cleans
// only its own path, so the leftover `repos/<owner>/<name>` from the previous
// run made `git clone` exit 128 — and because that step sits before install,
// verify-diff and the metrics ratchet were both reported `skipped`. One green
// run, every run after it red, and nothing in the summary saying the ratchet
// had not executed.
//
// The script under test is EXTRACTED FROM THE WORKFLOW, not copied here: a
// copy would keep passing after someone edited the YAML, which is the failure
// mode this test exists to close.

const WORKFLOW = join(packageRoot, ".github", "workflows", "guardrails-gate.yml");
const STEP = "clone sibling repos (gits layout)";

/** The `run:` block of a named step, dedented, exactly as the runner would execute it. */
function stepScript(name: string): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) throw new Error(`no step named ${JSON.stringify(name)} in ${WORKFLOW}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run:\s*\|\s*$/.test(l));
  if (runAt < 0) throw new Error(`step ${JSON.stringify(name)} has no block \`run: |\``);
  const indent = (lines[runAt + 1] ?? "").match(/^\s*/)?.[0].length ?? 0;
  if (indent === 0) throw new Error(`step ${JSON.stringify(name)} has an empty run block`);
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    if ((l.match(/^\s*/)?.[0].length ?? 0) < indent) break;
    body.push(l.slice(indent));
  }
  const script = body.join("\n");
  if (/\$\{\{/.test(script)) {
    throw new Error(
      `step ${JSON.stringify(name)} interpolates \${{ }} inside its script — a caller-supplied input would run as a command here; pass it through env: instead`,
    );
  }
  return script;
}

// `git` stands in for the real one so the test needs no network. It reproduces
// exactly the rule under test — clone refuses a non-empty destination with
// exit 128 — and `realGitRefusesNonEmpty` below pins that claim to the actual
// git on this machine, so the shim cannot quietly become more permissive than
// the thing it imitates.
const GIT_SHIM = `#!/bin/sh
if [ "$1" != "clone" ]; then exit 0; fi
dest=""
for a in "$@"; do dest="$a"; done
if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
  echo "fatal: destination path '$dest' already exists and is not an empty directory." >&2
  exit 128
fi
mkdir -p "$dest"
echo cloned > "$dest/CLONED"
exit 0
`;

let failed = 0;
const fail = (m: string): void => {
  console.error(`FAIL sibling-clone: ${m}`);
  failed++;
};

/** Run the extracted step in `ws` with the shim on PATH. */
function runStep(ws: string, siblings: string, mainRepo: string, script: string, bin: string) {
  const res = spawnSync("sh", ["-c", script], {
    cwd: ws,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SIBLING_TOKEN: "t0ken",
      SIBLING_REPOS: siblings,
      MAIN_REPO: mainRepo,
    },
  });
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

/** The claim the shim rests on: real git clone refuses a non-empty destination. */
function realGitRefusesNonEmpty(base: string): void {
  const src = join(base, "origin");
  const dest = join(base, "dest");
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "leftover.txt"), "from the previous run\n");
  const g = (...a: string[]) => spawnSync("git", ["-C", src, ...a], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", src], { encoding: "utf8" });
  writeFileSync(join(src, "f.txt"), "x\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const r = spawnSync("git", ["clone", "--depth=1", src, dest], { encoding: "utf8" });
  if (r.status !== 128 || !r.stderr.includes("already exists and is not an empty directory")) {
    fail(
      `real \`git clone\` into a non-empty directory exited ${r.status} — the shim below imitates a rule this git no longer has: ${r.stderr.trim()}`,
    );
  } else {
    console.log("  ok  sibling-clone: real git clone refuses a non-empty destination (128)");
  }
}

const base = mkdtempSync(join(tmpdir(), "guardrails-sibclone-"));
try {
  const script = stepScript(STEP);
  console.log(`  ok  sibling-clone: extracted the real \`${STEP}\` script from the workflow`);

  realGitRefusesNonEmpty(base);

  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), GIT_SHIM);
  chmodSync(join(bin, "git"), 0o755);

  // 1 — two consecutive runs in a workspace that is NOT cleaned between them.
  // This is the acceptance criterion: the second run is the one that was red.
  {
    const ws = join(base, "ws-twice");
    mkdirSync(ws, { recursive: true });
    const first = runStep(ws, "byoklab/components", "byoklab/tg-gallery", script, bin);
    if (first.status !== 0) {
      fail(`first run on a clean workspace exited ${first.status}: ${first.out.trim()}`);
    } else {
      console.log("  ok  sibling-clone: first run on a clean workspace clones");
    }
    // The leftover the runner keeps, plus a file that must NOT survive: a
    // sibling left from last week is a stale answer, not a cheap one.
    writeFileSync(join(ws, "repos", "byoklab", "components", "STALE"), "last week\n");
    const second = runStep(ws, "byoklab/components", "byoklab/tg-gallery", script, bin);
    if (second.status !== 0) {
      fail(
        `second run on the same workspace exited ${second.status} — the leftover clone is still fatal: ${second.out.trim()}`,
      );
    } else {
      console.log(
        "  ok  sibling-clone: second run on the SAME dirty workspace clones (was exit 128)",
      );
    }
    const left = readdirSync(join(ws, "repos", "byoklab", "components"));
    if (left.includes("STALE")) {
      fail("the second run reused last run's tree — a stale sibling is a wrong gate answer");
    } else if (!left.includes("CLONED")) {
      fail(`the second run left no clone behind: ${left.join(", ")}`);
    } else {
      console.log("  ok  sibling-clone: the second run's tree is fresh, not the leftover");
    }
  }

  // 2 — several siblings, twice, because the loop is where a partial fix hides.
  {
    const ws = join(base, "ws-many");
    mkdirSync(ws, { recursive: true });
    const many = "byoklab/components byoklab/dam";
    runStep(ws, many, "byoklab/tg-gallery", script, bin);
    const again = runStep(ws, many, "byoklab/tg-gallery", script, bin);
    if (again.status !== 0) {
      fail(`the second run with two siblings exited ${again.status}: ${again.out.trim()}`);
    } else {
      console.log("  ok  sibling-clone: two siblings, second run still clean");
    }
  }

  // 3 — the repo under test must never appear as a sibling: repos/$MAIN_REPO
  // holds this run's own checkout, and the step now removes what it clones.
  {
    const ws = join(base, "ws-self");
    const own = join(ws, "repos", "byoklab", "tg-gallery");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "package.json"), "{}\n");
    const r = runStep(ws, "byoklab/tg-gallery", "byoklab/tg-gallery", script, bin);
    if (r.status === 0) {
      fail("listing the repo under test as its own sibling was accepted");
    } else if (readdirSync(own).length === 0) {
      fail("the step deleted this run's own checkout before refusing");
    } else {
      console.log("  ok  sibling-clone: the repo under test is refused, its checkout untouched");
    }
  }

  // 4 — an entry that is not owner/name is refused rather than turned into a
  // path. `..` is the one that walks out of the workspace under rm -rf.
  for (const bad of ["byoklab/components/../../..", "/etc", "notapair", "a/b/c"]) {
    const ws = join(base, `ws-bad-${Buffer.from(bad).toString("hex")}`);
    mkdirSync(ws, { recursive: true });
    const r = runStep(ws, bad, "byoklab/tg-gallery", script, bin);
    if (r.status === 0) {
      fail(`sibling_repos entry ${JSON.stringify(bad)} was accepted`);
    } else {
      console.log(`  ok  sibling-clone: refused sibling_repos entry ${JSON.stringify(bad)}`);
    }
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`sibling-clone: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("sibling-clone: all checks passed");
