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
  guardrails metrics                  not implemented yet (exit 3); ships separately

All subcommands accept --json.
Exit codes: 0 ok · 1 findings · 2 usage or missing tool · 3 not implemented
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

  let base: string | undefined;
  const baseIdx = filtered.indexOf("--base");
  if (baseIdx >= 0) {
    base = filtered[baseIdx + 1];
    if (base === undefined) {
      console.error("guardrails: --base requires a ref argument");
      return 2;
    }
    filtered.splice(baseIdx, 2);
  }

  // ast-grep-ignore: non-exhaustive-match -- `command` is arbitrary CLI input (open string), not a closed union; the otherwise arm IS the unknown-subcommand error path
  return match(command)
    .with("verify", () => runVerify(filtered, json))
    .with("verify-diff", () => runVerifyDiff(base, json))
    .with("doctor", () => runDoctor(json))
    .with("init", () => runInit(json))
    .with("metrics", () => runMetrics(json))
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
