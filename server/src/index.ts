import { config, ensureDataDirs } from './config.ts';
import { createApp } from './app.ts';
import { openContext } from './bootstrap.ts';
import { DataTooNewError } from './db/index.ts';
import { importSeed, SEED_PATH } from './db/seed.ts';
import { registerTask, schedulerFor } from './scheduler.ts';
import { startLogFile } from './util/log.ts';
import { endChildren } from './util/proc.ts';
import { registerBuiltInTasks, relevelRisk } from './tasks.ts';
import { runNoticeCheck, runRepoHeadWatch } from './watch/heads.ts';
import { runFirstSeenFill } from './search/browse.ts';
import { runUsageScan, USAGE_SCAN_EVERY_MS } from './usage/scan.ts';
import { runQuarantinePrune } from './install/quarantine.ts';
import { getSettings } from './settings.ts';

const HOST = '127.0.0.1';

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
// Every background task runs from one scheduler (feature review B2); other pieces add theirs with registerTask.
registerBuiltInTasks();
// feature review stage 2: installed and favorite skills' repos re-read when their HEAD moved (B3), and the notices
// for what changed (F7); skills indexed since the last run get their first-seen time (F17)
registerTask({ kind: 'repo-heads', label: '저장소 변경 확인', everyMs: 6 * 60 * 60 * 1000, network: true, startup: true, timeoutMs: 30 * 60 * 1000, run: (c) => runRepoHeadWatch(c) });
registerTask({ kind: 'notice-check', label: '변화 알림 확인', everyMs: 60 * 60 * 1000, run: (c) => runNoticeCheck(c) });
registerTask({ kind: 'first-seen', label: '새 스킬 시각 기록', everyMs: 60 * 60 * 1000, startup: true, run: (c) => runFirstSeenFill(c) });
// feature review stage 3: skill uses from Claude Code's transcripts, only while the setting is on (F11, decision 14),
// and the undo copies kept before a delete or overwrite (F14)
registerTask({ kind: 'usage-scan', label: '스킬 사용 기록 읽기', everyMs: USAGE_SCAN_EVERY_MS, startup: true, timeoutMs: 2 * 60 * 1000, enabled: (c) => getSettings(c.store).usageScan, run: (c, info) => runUsageScan(c, info) });
registerTask({ kind: 'quarantine-prune', label: '되돌리기 보관함 정리', everyMs: 24 * 60 * 60 * 1000, startup: true, timeoutMs: 2 * 60 * 1000, run: (c) => runQuarantinePrune(c) });
const scheduler = schedulerFor(ctx);
const app = createApp(ctx);

// Express' listen(port) binds 0.0.0.0; always pass the loopback host explicitly.
const server = app.listen(config.port, HOST, () => {
  console.log(`Skill Finder: http://${HOST}:${config.port}${config.dev ? ' (dev)' : ''}`);
  console.log(`GitHub 토큰: ${config.githubToken ? '있음' : '없음 (GitHub 코드 검색 생략, 트리는 git으로 조회)'}`);
  relevelRisk(ctx); // startup only, no download: levels from the stored flags
  // sync, star counts, risk re-check, log pruning and the update check at start, then each when due (tasks.ts)
  scheduler.start();
});

server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

// SIGHUP: the terminal window was closed. Without a handler Node would end without its 'exit' event, and outside
// Windows the commands the app started (each in a process group of its own, util/proc.ts) would keep running.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    server.close();
    // running commands (an install, a git clone) get a moment to stop and clean up; what is left is ended on exit
    void endChildren().finally(() => {
      ctx.store.db.close();
      process.exit(0);
    });
  });
}
