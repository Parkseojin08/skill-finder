import { config, ensureDataDirs } from './config.ts';
import { createApp } from './app.ts';
import { openContext } from './bootstrap.ts';
import { DataTooNewError } from './db/index.ts';
import { importSeed, SEED_PATH } from './db/seed.ts';
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
// A new install starts from the index shipped with the release instead of an empty one; any problem only costs speed.
try {
  const t0 = Date.now();
  const seeded = importSeed(ctx.store, SEED_PATH);
  if (seeded) console.log(`[seed] 미리 만든 색인을 넣었습니다: 스킬 ${seeded.skills}개, 플러그인 ${seeded.plugins}개, 저장소 ${seeded.repos}개 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
} catch (err) {
  console.warn('[seed] 미리 만든 색인을 넣지 못해 GitHub에서 처음부터 모읍니다:', String((err as Error).message ?? err).slice(0, 200));
}
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
