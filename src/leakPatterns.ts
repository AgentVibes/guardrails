// The private-infrastructure marker list for `guardrails leaks`. This file is
// the ONE place the markers may appear in this public repo — the scanner
// excludes any file named leakPatterns.* (source and dist twins) from its own
// scan, the same self-exemption audit-sensitive.sh uses in agent-skills.
//
// The boundary rule (spec layer A″): public code holds mechanisms, private
// config holds facts. No hostname, path, org name, or token belonging to the
// private topology may appear anywhere else in this repo — red CI, not a
// review-eyes convention.

export interface LeakPattern {
  id: string;
  regex: RegExp;
}

export const LEAK_PATTERNS: LeakPattern[] = [
  { id: "infra-domain", regex: /byokapi\.com/i },
  { id: "owner-name", regex: /yatsyk/i },
  { id: "infra-host", regex: /hzded/i },
  { id: "legacy-zone", regex: /\bpg1\b/ },
  { id: "ingress-name", regex: /dev-ingress/ },
  { id: "sso-name", regex: /tinyauth/ },
  { id: "vault-path", regex: /ObsidianSyncFolder/ },
  { id: "home-path", regex: /\/home\/andrew/ },
  { id: "lan-subnet", regex: /10\.10\.10\./ },
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
