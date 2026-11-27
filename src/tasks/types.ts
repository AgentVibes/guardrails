export type TaskVerb = "build" | "lint" | "typecheck" | "test" | "format" | "run";

export const TASK_VERBS: readonly TaskVerb[] = [
  "build",
  "lint",
  "typecheck",
  "test",
  "format",
  "run",
];

export function isTaskVerb(value: string): value is TaskVerb {
  return (TASK_VERBS as readonly string[]).includes(value);
}

export interface DetectionResult {
  applicable: boolean;
  reason: string;
}

export interface TaskContext {
  nodeVersion?: string;
  /** Override binary lookup in tests. */
  hasBinary?: (root: string, binary: string) => boolean;
}

export interface TaskProvider {
  id: string;
  verb: TaskVerb;
  binary: string;
  installHint: string;
  detect: (root: string, ctx?: TaskContext) => DetectionResult;
  /** Higher wins among applicable providers when no config is set (default 0). */
  priority?: (root: string, ctx?: TaskContext) => number;
  command: (root: string, args: readonly string[], ctx?: TaskContext) => string[];
  /** Optional one-line warning printed before running (e.g. legacy TypeScript). */
  warning?: (root: string, ctx?: TaskContext) => string | undefined;
  /** Optional follow-up steps after the primary binary exits 0 (e.g. verify-diff + doctor for lint). */
  after?: (root: string, json: boolean) => number;
}

export interface ProviderEntry {
  id: string;
  binary: string;
  applicable: boolean;
  available: boolean;
  active: boolean;
  reason: string;
}

export type ResolvedTask =
  | {
      status: "provider";
      verb: TaskVerb;
      provider: TaskProvider;
      argv: string[];
      why: string;
      warning: string | undefined;
      configKey: string;
    }
  | {
      status: "custom";
      verb: TaskVerb;
      command: string;
      argv: string[];
      why: string;
      configKey: string;
    }
  | {
      status: "none";
      verb: TaskVerb;
      why: string;
      configKey: string;
    };

export interface VerbReport {
  active: string | null;
  why: string;
  command: string[] | null;
  configKey: string;
  providers: ProviderEntry[];
}
