import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `guardrails iterate` — the iterate-until-pass harness (spec layer D): run a
// cheap model against a task, let the GATE be the teacher. The harness never
// believes the agent's own report — after every attempt it runs the gate
// itself; findings become the next prompt's compact feedback; the loop ends on
// green or the attempt limit.
//
//   guardrails iterate --task task.md --cmd 'claude -p "$(cat "$GUARDRAILS_PROMPT_FILE")"'
//
// Contract with the runner command (executed via bash -c, per attempt):
//   - $GUARDRAILS_PROMPT_FILE — path to this attempt's full prompt
//   - $GUARDRAILS_ATTEMPT    — attempt number, 1-based
//   - stdin                  — the same prompt text
// The gate command (--gate, default `<this cli> verify-diff`) runs in cwd;
// exit 0 = green. Every attempt is recorded (task, gate exit, findings tail,
// duration) and the whole record prints at the end — the tuple layer D wants
// kept for skill iteration.

export interface IterateOptions {
  task: string | undefined;
  cmd: string | undefined;
  gate: string | undefined;
  max: number;
  json: boolean;
  cliPath: string;
}

interface Attempt {
  attempt: number;
  agentExit: number;
  gateExit: number;
  gateTail: string;
  seconds: number;
}

function readTask(task: string): string {
  if (existsSync(task)) return readFileSync(task, "utf8");
  return task;
}

const FEEDBACK_HEADER =
  "The verification gate FAILED on your previous attempt. Fix ONLY the findings below — do not refactor anything the gate did not name, do not weaken any rule, config, or baseline. Findings:";

export function runIterate(opts: IterateOptions): number {
  if (opts.task === undefined || opts.cmd === undefined) {
    console.error(
      "guardrails iterate: --task <file-or-text> and --cmd '<runner command>' are required. See README 'Iterate harness'.",
    );
    return 2;
  }
  const taskText = readTask(opts.task);
  const gateCmd = opts.gate ?? `node ${opts.cliPath} verify-diff`;
  const dir = mkdtempSync(join(tmpdir(), "guardrails-iterate-"));
  const attempts: Attempt[] = [];
  let feedback = "";

  for (let attempt = 1; attempt <= opts.max; attempt++) {
    const prompt = feedback === "" ? taskText : `${taskText}\n\n${FEEDBACK_HEADER}\n${feedback}`;
    const promptFile = join(dir, `prompt-${attempt}.md`);
    writeFileSync(promptFile, prompt);

    const t0 = performance.now();
    const agent = spawnSync("bash", ["-c", opts.cmd], {
      input: prompt,
      encoding: "utf8",
      env: {
        ...process.env,
        GUARDRAILS_PROMPT_FILE: promptFile,
        GUARDRAILS_ATTEMPT: String(attempt),
      },
      maxBuffer: 64 * 1024 * 1024,
    });

    const gate = spawnSync("bash", ["-c", gateCmd], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const seconds = Math.round((performance.now() - t0) / 100) / 10;
    const gateOut = `${gate.stdout}${gate.stderr}`;
    const gateTail = gateOut
      .split("\n")
      .filter((l) => l !== "")
      .slice(-30)
      .join("\n");
    attempts.push({
      attempt,
      agentExit: agent.status ?? -1,
      gateExit: gate.status ?? -1,
      gateTail,
      seconds,
    });
    console.error(
      `guardrails iterate: attempt ${attempt}/${opts.max} — agent exit ${agent.status}, gate exit ${gate.status} (${seconds}s)`,
    );

    // ast-grep-ignore: kind-if-without-match -- gate.status is spawnSync's numeric exit code (number | null), not a discriminated-union tag
    if (gate.status === 0) {
      finish(opts.json, attempts, true);
      return 0;
    }
    feedback = gateTail;
  }
  finish(opts.json, attempts, false);
  return 1;
}

function finish(json: boolean, attempts: Attempt[], green: boolean): void {
  if (json) {
    console.log(JSON.stringify({ command: "iterate", green, attempts }, null, 2));
    return;
  }
  console.log(
    `guardrails iterate: ${green ? "GREEN" : "still red"} after ${attempts.length} attempt(s)`,
  );
  for (const a of attempts) {
    console.log(
      `  attempt ${a.attempt}: agent exit ${a.agentExit}, gate exit ${a.gateExit}, ${a.seconds}s`,
    );
  }
  if (!green) {
    const last = attempts[attempts.length - 1];
    console.log(`last gate output:\n${last?.gateTail ?? ""}`);
  }
}
