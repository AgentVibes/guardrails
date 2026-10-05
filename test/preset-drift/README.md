# Preset-drift fixtures (is-9c7a78d7)

Each `*.json` here is a small repository tree: keys are paths, values are the
JSON written at that path. `src/presetDriftTest.ts` materialises every fixture
in a temp directory and runs `presetDrift`, `guardrails verify` and
`guardrails doctor` against it.

- `valid/` — must report no drift; `verify` and `doctor` exit 0.
- `invalid/<key>--<name>.json` — must report drift with finding key `<key>`;
  `verify` exits 2 and `doctor` exits 1, with no opt-in anywhere in the tree.

The files are not named `biome.json` on purpose: a nested `biome.json` in this
repository would itself be drift, and biome would load it as a nested config.
