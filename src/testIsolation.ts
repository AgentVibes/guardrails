// Imported first by every test that spawns the CLI: a developer who records
// their own runs (GUARDRAILS_RECORD in the shell) must not get test fixtures
// in their database. Children inherit process.env, so clearing it here covers
// every spawn. Tests that exercise recording set the variable per spawn.
delete process.env.GUARDRAILS_RECORD;
