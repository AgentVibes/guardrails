// Built-in patterns for `guardrails leaks` — GENERIC credential shapes only.
// Deliberately NO infrastructure markers here: a list of private hostnames,
// org names, or subnets is itself a fact about the private topology (spec
// layer A″: code carries mechanisms, config carries facts), so house marker
// lists reach the scanner through `.guardrails/leaks.txt`, a
// `[leaks] patterns_file =` manifest entry, or a plugin's `leakPatterns()` —
// never through this public package.

export interface LeakPattern {
  id: string;
  regex: RegExp;
}

export const LEAK_PATTERNS: LeakPattern[] = [
  { id: "github-token", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { id: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9-]{10,}\b/ },
  { id: "openai-key", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { id: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "gitlab-token", regex: /\bglpat-[A-Za-z0-9_-]{20}\b/ },
  { id: "slack-token", regex: /\bxox[bap]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: "private-key-block",
    regex: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/,
  },
];
