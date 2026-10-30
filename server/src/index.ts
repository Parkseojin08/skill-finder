import { config, ensureDataDirs } from './config.ts';
import { createApp } from './app.ts';
import { createContext } from './bootstrap.ts';
import { DataTooNewError } from './db/index.ts';
import { pruneSearchLog, recheckRiskRules, refreshRepoMeta, relevelRisk, REPO_META_EVERY_MS, startSync } from './tasks.ts';

const HOST = '127.0.0.1';
const DAY_MS = 24 * 60 * 60 * 1000;

ensureDataDirs();
const ctx = (() => {
  try {
    return createContext(config);
  } catch (err) {
    if (!(err instanceof DataTooNewError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
})();
const app = createApp(ctx);

// Express' listen(port) binds 0.0.0.0; always pass the loopback host explicitly.
const server = app.listen(config.port, HOST, () => {
  console.log(`Skill Finder: http://${HOST}:${config.port}${config.dev ? ' (dev)' : ''}`);
  console.log(`GitHub 토큰: ${config.githubToken ? '있음' : '없음 (GitHub 코드 검색 생략, 트리는 git으로 조회)'}`);
  startSync(ctx);
  setInterval(() => startSync(ctx), DAY_MS).unref();
  pruneSearchLog(ctx);
  setInterval(() => pruneSearchLog(ctx), DAY_MS).unref();
  relevelRisk(ctx);
  void recheckRiskRules(ctx);
  setInterval(() => void recheckRiskRules(ctx), DAY_MS).unref();
  void refreshRepoMeta(ctx);
  setInterval(() => void refreshRepoMeta(ctx), REPO_META_EVERY_MS).unref();
});

server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    ctx.store.db.close();
    process.exit(0);
  });
}
