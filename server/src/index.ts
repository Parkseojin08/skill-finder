import { config, ensureDataDirs } from './config.ts';
import { createApp } from './app.ts';
import { openContext } from './bootstrap.ts';
import { DataTooNewError } from './db/index.ts';
import { startUpdateChecks } from './update.ts';
import { startLogFile } from './util/log.ts';
import { pruneSearchLog, recheckRiskRules, refreshRepoMeta, relevelRisk, REPO_META_EVERY_MS, startSync } from './tasks.ts';

const HOST = '127.0.0.1';
const DAY_MS = 24 * 60 * 60 * 1000;

ensureDataDirs();
startLogFile(config.dataDir, [config.githubToken]);
// A background task that fails (a sync, a refresh) is logged, not fatal: Node would otherwise end the server.
process.on('unhandledRejection', (reason) => console.error('[백그라운드 오류]', reason));
process.on('uncaughtException', (err) => {
  console.error('[치명적 오류]', err);
  process.exit(1);
});
const ctx = (() => {
  try {
    return openContext(config);
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
  startUpdateChecks();
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
