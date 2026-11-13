// Preloaded by bun test (server/bunfig.toml, and the root bunfig.toml), never by node's runner.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// `bun test` at the repo root (instead of `bun run test`) would run the server, web and e2e files in one process,
// where one file's modules leak into the next: run that way, a test once wrote its fake token into the real .env.
if (existsSync(join(process.cwd(), 'server', 'bunfig.toml'))) {
  console.error('저장소 맨 위에서는 bun test 대신 bun run test(또는 npm test)를 쓰세요. 서버와 웹 테스트를 파일마다 격리해 돌립니다.');
  process.exit(1);
}

// scripts/release.mjs refuses a real build or deploy inside tests, so a test that forgot to pass its own runner
// cannot start one: node --test tells it with NODE_TEST_CONTEXT, which it sets for the files it runs and what they
// start. bun test sets nothing like it (only NODE_ENV=test), and setting NODE_TEST_CONTEXT here would make Bun's
// node:test print every result as JSON, so the files and what they start get this instead.
process.env.SKILL_FINDER_TESTING = '1';
