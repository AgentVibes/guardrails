# candidates/ — un-triaged rule imports

These 11 R-rules come verbatim from `merkle-substrate/apps/ppa/.ast-grep/rules/`
(the PPA quality rules). They are **candidates**, not canon:

- they are NOT listed in the package `sgconfig.yml` and load nowhere by default;
- they have no fixtures and no assertions in the fixture harness;
- triage (rename to stable ids, write fixtures, pick severity, promote into
  `rules/`) happens in wave 2 of the agentvibes-guardrails project.

Do not point a `ruleDirs` at this directory until a rule has been promoted.
