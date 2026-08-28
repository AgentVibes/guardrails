#!/usr/bin/env node
import { match } from "ts-pattern";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runMetrics } from "./metrics.js";
import { ToolMissingError } from "./toolResolve.js";
import { runVerify } from "./verify.js";
import { runVerifyDiff } from "./verifyDiff.js";

const USAGE = `guardrails — verification toolkit that makes agents write simple code

Usage:
  guardrails verify [paths...]        scan with the bundled rule canon (+ text
                                      greps + react structure); exit 1 on any
                                      error-tier finding
  guardrails verify-diff [--base R]   added-lines ratchet vs merge-base; exit 1
                                      only on error-tier findings your diff added
  guardrails doctor                   tool versions, ruleset SHA, config discovery
  guardrails init                     write repo stubs: sgconfig.yml, biome.json,
                                      [stack] in .agentvibes/project.toml
  guardrails metrics [paths...]       per-component/file/project metrics; with
                                      --check compares GATED metrics against the
                                      committed baseline (.guardrails/metrics.json)
                                      and exits 1 on any regression;
                                      --update-baseline [--force] tightens the
                                      baseline (2% hysteresis); --snapshot appends
                                      a JSONL trend row; --baseline <path> overrides

All subcommands accept --json.
Exit codes: 0 ok · 1 findings/regression · 2 usage, missing tool, or missing baseline
`;

function main(argv: string[]): number {
  const args = [...argv];
  const json = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");
  const command = filtered.shift();

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  const takeValueFlag = (flag: string): string | undefined | null => {
    const idx = filtered.indexOf(flag);
    if (idx < 0) return undefined;
    const value = filtered[idx + 1];
    // ast-grep-ignore: silent-default-return -- deliberate tri-state, not a fallback: null means "flag present but value missing" and every caller turns it into a usage error
    if (value === undefined) return null;
    filtered.splice(idx, 2);
    return value;
  };
  const takeBoolFlag = (flag: string): boolean => {
    const idx = filtered.indexOf(flag);
    if (idx < 0) return false;
    filtered.splice(idx, 1);
    return true;
  };

  const base = takeValueFlag("--base");
  if (base === null) {
    console.error("guardrails: --base requires a ref argument");
    return 2;
  }
  const baselinePath = takeValueFlag("--baseline");
  if (baselinePath === null) {
    console.error("guardrails: --baseline requires a path argument");
    return 2;
  }
  const check = takeBoolFlag("--check");
  const updateBaseline = takeBoolFlag("--update-baseline");
  const force = takeBoolFlag("--force");
  const snapshot = takeBoolFlag("--snapshot");

  // ast-grep-ignore: non-exhaustive-match -- `command` is arbitrary CLI input (open string), not a closed union; the otherwise arm IS the unknown-subcommand error path
  return match(command)
    .with("verify", () => runVerify(filtered, json))
    .with("verify-diff", () => runVerifyDiff(base, json))
    .with("doctor", () => runDoctor(json))
    .with("init", () => runInit(json))
    .with("metrics", () =>
      runMetrics({ targets: filtered, json, check, updateBaseline, force, snapshot, baselinePath }),
    )
    .otherwise(() => {
      console.error(`guardrails: unknown subcommand '${command}'\n`);
      console.error(USAGE);
      return 2;
    });
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  if (err instanceof ToolMissingError) {
    console.error(`guardrails: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
