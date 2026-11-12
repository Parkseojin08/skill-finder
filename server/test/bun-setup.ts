// Preloaded by bun test (bunfig.toml), never by node's runner. scripts/release.mjs refuses a real build or deploy
// inside tests, so a test that forgot to pass its own runner cannot start one: node --test tells it with
// NODE_TEST_CONTEXT, which it sets for the files it runs and what they start. bun test sets nothing like it (only
// NODE_ENV=test), and setting NODE_TEST_CONTEXT here would make Bun's node:test print every result as JSON, so the
// files and what they start get this instead.
process.env.SKILL_FINDER_TESTING = '1';
