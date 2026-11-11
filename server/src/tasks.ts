import { RISK_RULES_VERSION, riskLevel, type RiskFlag } from './analyze/risk.ts';
import type { AppContext } from './context.ts';
import type { SkillRow } from './db/store.ts';
import { runClusterRefresh } from './dedupe/clusters.ts';
import { minhashBytes, skillMinhash } from './dedupe/minhash.ts';
import { setSkillMinhash } from './dedupe/rows.ts';
import { skillMdPath } from './discovery/tree.ts';
import { PluginUnavailableError, recheckRisk, skillMdHash } from './indexer.ts';
import type { Job, JobControl } from './jobs.ts';
import { GitHubError, GRAPHQL_BATCH, pruneRepoStars } from './sources/github.ts';
import { syncMarketplace } from './sources/marketplace.ts';
import { collectPopularRepos, popularState } from './sources/popularRepos.ts';
import { searchActivity } from './search/activity.ts';
import { bumpIndexGeneration, pruneSearchCache, trackIndexChanges } from './search/indexGeneration.ts';
import { getSettings, SEARCH_LOG_KEEP_MS } from './settings.ts';
import { pool, sleep } from './util/limiter.ts';
import { registerTask, schedulerFor, type TaskOutcome } from './scheduler.ts';
import { runDbMaintenance } from './dbMaintenance.ts';
import { runUpdateCheck, UPDATE_CHECK_EVERY_MS } from './update.ts';

const COLLECT_CONCURRENCY = 4;
const BACKGROUND_CONCURRENCY = 3;

async function indexPending(ctx: AppContext, marketplace: string, ctl: JobControl, background = false): Promise<void> {
  const pending = ctx.store.listPluginsNeedingIndex(marketplace);
  ctl.addTotal(pending.length);
  await pool(
    pending,
    background ? BACKGROUND_CONCURRENCY : COLLECT_CONCURRENCY,
    async (p) => {
      await ctl.checkpoint();
      // Background collection steps aside while a search is running so searches stay fast.
      while (background && searchActivity.busy() && !ctl.cancelled) await sleep(500);
      try {
        await ctx.indexer.indexPlugin(p.id);
        ctl.tick();
      } catch (err) {
        const line = `${p.id}: ${String((err as Error).message ?? err).slice(0, 200)}`;
        if (err instanceof PluginUnavailableError) ctl.skip(line);
        else ctl.tick(line);
      }
    },
    () => ctl.cancelled,
  );
}

/**
 * A sync where no marketplace could be read (offline, GitHub down): the first error, so the scheduler tries again
 * soon instead of in 24 hours (P10). The job itself still ends as before, with the errors listed.
 */
const syncOutcomes = new WeakMap<Job, { read: number; error?: unknown }>();

/** Syncs marketplace.json for one or all enabled marketplaces; eager ones also index their plugins' skills. */
export function startSync(ctx: AppContext, marketplace?: string, force = false): Job {
  const label = marketplace ?? '*';
  const running = ctx.jobs.active('sync', label);
  if (running) return running;
  const outcome: { read: number; error?: unknown } = { read: 0 };
  const job = ctx.jobs.start('sync', label, async (ctl) => {
    const targets = ctx.store
      .listMarketplaces()
      .filter((m) => (marketplace ? m.name === marketplace : m.enabled === 1));
    ctl.setTotal(targets.length);
    const eager: string[] = [];
    // B1: the index generation goes up only when this sync changed what a search returns (it runs at every start,
    // and emptying the search cache each time left it empty); old cached searches are only aged out
    await trackIndexChanges(ctx.store, async (flush) => {
      for (const m of targets) {
        await ctl.checkpoint();
        try {
          await syncMarketplace(ctx.store, ctx.github, m.name, force);
          outcome.read++;
          ctl.tick();
          if (m.index_mode === 'eager') eager.push(m.name);
        } catch (err) {
          outcome.error ??= err;
          ctl.tick(`${m.name}: ${String((err as Error).message ?? err).slice(0, 200)}`);
        }
      }
      // Every list first, then the skills of the marketplace with the fewest plugins to read: Anthropic's own skills
      // (5 plugins) used to wait about 100 s for the 300-plugin official list on a first run (2026-11-03).
      const pending = new Map(eager.map((name) => [name, ctx.store.listPluginsNeedingIndex(name).length]));
      for (const name of eager.sort((a, b) => pending.get(a)! - pending.get(b)!)) {
        await indexPending(ctx, name, ctl);
        flush(); // each marketplace's skills searchable as soon as they are in (D#323b)
      }
    });
    pruneSearchCache(ctx.store);
    if (!marketplace && getSettings(ctx.store).autoCollect) {
      startAutoCollect(ctx);
      const last = popularState(ctx).lastRunAt;
      if (!last || Date.now() - Date.parse(last) > POPULAR_EVERY_MS) startPopularCollect(ctx, true);
    }
  });
  syncOutcomes.set(job, outcome);
  return job;
}

/** Scheduler task "마켓플레이스 동기화": the full sync, failed when not one marketplace could be read. */
export async function runSync(ctx: AppContext): Promise<TaskOutcome> {
  const job = startSync(ctx);
  await ctx.jobs.wait(job.id);
  const outcome = syncOutcomes.get(job);
  if (job.status === 'error') throw new Error(job.errors.at(-1) ?? '동기화 실패');
  if (outcome && outcome.read === 0 && outcome.error) throw outcome.error;
  return { counts: { marketplaces: outcome?.read ?? 0, done: job.done, total: job.total, errors: job.errors.length } };
}

const POPULAR_EVERY_MS = 24 * 60 * 60 * 1000;
/** How often repo metadata is refreshed, and what counts as old enough to refresh. */
export const REPO_META_EVERY_MS = 6 * 60 * 60 * 1000;
const REPO_META_STALE_MS = 18 * 60 * 60 * 1000;
let repoMetaRunning = false;
/** The smallest group asked again in halves; a group this small that still fails waits for the next run. */
const REPO_META_MIN_SPLIT = 25;

/** GitHub gave up on the query (502/503/504, usually when it takes too long) or our own 30 s limit ran out. */
const gaveUp = (err: unknown) => (err instanceof GitHubError && [502, 503, 504].includes(err.status)) || (err as Error)?.name === 'TimeoutError';

const NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
/**
 * One request that broke on the way (problem P5): an answer cut short ("Unexpected end of JSON input") or the
 * connection failing (fetch's TypeError, its cause carrying the code). Asking the same group again usually works.
 */
export const brokeOnTheWay = (err: unknown): boolean => {
  if (err instanceof SyntaxError) return true;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } } | null;
  if (!e) return false;
  if (NET_CODES.has(e.code ?? '') || NET_CODES.has(e.cause?.code ?? '')) return true;
  return e.name === 'TypeError' && /fetch failed|terminated|network|socket/i.test(e.message ?? '');
};
/** Pause before asking a group again after it broke on the way (tests set it to 0). */
export const REPO_META_RETRY = { waitMs: 2000 };
/** Groups in a row that broke even when asked again: the network is down, so the run stops until the next one. */
const REPO_META_MAX_BROKEN = 3;

/**
 * One group of repos, asked again in halves when GitHub gives up on it: a hundred lookups in one query can take
 * too long, and one 502 used to end the whole run, leaving the rest stale until the next one 6 hours later
 * (2026-11-03). A group whose answer broke on the way (cut-short JSON, a dropped connection) is asked once more
 * and then left for the next run, so the run goes on with the next group (P5). Other errors (limit reached)
 * still end the run.
 */
async function refreshRepoGroup(ctx: AppContext, repos: string[]): Promise<{ stored: number; left: number; error?: unknown; broken?: boolean }> {
  try {
    return { stored: await ctx.github.refreshRepoMeta(repos), left: 0 };
  } catch (err) {
    if (brokeOnTheWay(err)) {
      await sleep(REPO_META_RETRY.waitMs);
      try {
        return { stored: await ctx.github.refreshRepoMeta(repos), left: 0 };
      } catch (again) {
        if (!brokeOnTheWay(again) && !gaveUp(again)) throw again;
        return { stored: 0, left: repos.length, error: again, broken: true };
      }
    }
    if (!gaveUp(err)) throw err;
    if (repos.length <= REPO_META_MIN_SPLIT) return { stored: 0, left: repos.length, error: err };
    const half = Math.ceil(repos.length / 2);
    const a = await refreshRepoGroup(ctx, repos.slice(0, half));
    const b = await refreshRepoGroup(ctx, repos.slice(half));
    return { stored: a.stored + b.stored, left: a.left + b.left, error: b.error ?? a.error, broken: a.broken && b.broken };
  }
}

/** One pass over the repos due for a refresh; adds to `got` as it goes and throws when GitHub cannot be asked. */
async function repoMetaPass(ctx: AppContext, got: { stored: number; left: number }): Promise<void> {
  const repos = ctx.store.listReposToRefresh(new Date(Date.now() - REPO_META_STALE_MS).toISOString(), 10_000);
  let brokenInRow = 0;
  for (let i = 0; i < repos.length; i += GRAPHQL_BATCH) {
    await yieldToSearch();
    const group = repos.slice(i, i + GRAPHQL_BATCH);
    const r = await refreshRepoGroup(ctx, group);
    got.stored += r.stored;
    got.left += r.left;
    if (r.left === group.length && r.broken) {
      // this group's answers broke twice: skip it, unless the last few all did (the network is down)
      if (++brokenInRow >= REPO_META_MAX_BROKEN) throw r.error;
      continue;
    }
    brokenInRow = 0;
    // not one piece answered: GitHub is down rather than slow, so stop asking until the next run
    if (r.left === group.length) throw r.error;
  }
  if (got.left) console.warn('[repo-meta]', `GitHub가 일부 요청에 답하지 않아 저장소 ${got.left}개는 다음 갱신 때 다시 묻습니다`);
}

/**
 * Keeps star counts of the repos skills come from current (GraphQL, 100 per call), so a search reads them
 * from the database instead of asking GitHub per repo, and fills repos never fetched (indexed without a
 * token). Steps aside while a search runs; does nothing without a token. Errors are logged, not thrown.
 */
export async function refreshRepoMeta(ctx: AppContext): Promise<number> {
  if (repoMetaRunning || !ctx.github.hasToken) return 0;
  repoMetaRunning = true;
  const got = { stored: 0, left: 0 };
  try {
    await repoMetaPass(ctx, got);
  } catch (err) {
    console.warn('[repo-meta]', String((err as Error).message ?? err).slice(0, 200));
  } finally {
    repoMetaRunning = false;
  }
  return got.stored;
}

/** Scheduler task "별 정보 갱신": as refreshRepoMeta, but a pass GitHub could not answer fails (and is retried). */
export async function runRepoMeta(ctx: AppContext): Promise<TaskOutcome> {
  if (!ctx.github.hasToken) return { skipped: true, note: '토큰 없음' };
  if (repoMetaRunning) return { skipped: true, note: '이미 갱신 중' };
  repoMetaRunning = true;
  const got = { stored: 0, left: 0 };
  try {
    await repoMetaPass(ctx, got);
  } finally {
    repoMetaRunning = false;
  }
  return { counts: got };
}

const RISK_RECHECK_BATCH = 50;
const RISK_RECHECK_EVERY_MS = 20 * 60 * 60 * 1000;
/** Setting: when the last risk re-check pass finished. */
const RISK_RECHECK_KEY = 'riskRecheckAt';
/** Setting: the id the signature fill (B8) stopped at, so the next pass goes on from there ('' = from the start). */
const MINHASH_FILL_KEY = 'minhashFillAfter';

/**
 * Steps aside while a search runs, but not forever: a search left marked busy must not hold a background pass for good
 * (as watch/heads.ts waits, review 2026-11-05).
 */
async function yieldToSearch(): Promise<void> {
  for (let waited = 0; searchActivity.busy() && waited < 120_000; waited += 500) await sleep(500);
}
let riskRecheckRunning = false;

/** One re-check pass; adds to `got` as it goes, throws on what stops it (the time of the pass is then not saved). */
async function riskRecheckPass(ctx: AppContext, now: number, got: { checked: number; changed: number }, signed = { n: 0 }): Promise<void> {
  for (let after = ''; ; ) {
    const rows = ctx.store.listSkillsForRiskRecheck(RISK_RULES_VERSION, after, RISK_RECHECK_BATCH);
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;
    const results = await pool(rows, 8, async (row) => {
      await yieldToSearch(); // raw downloads share their slots with searches
      const r = await ctx.github.getRawText(row.repo!, row.ref!, skillMdPath(row.dir_path!));
      const next = r.text == null ? null : recheckRisk(row, r.text);
      // B8: the signature of a row indexed before it, from the file read anyway (recheckRisk checked it is the same text)
      return next ? { ...next, minhash: row.minhash == null ? minhashBytes(skillMinhash(r.text!)) : null } : null;
    });
    ctx.store.transaction(() => {
      rows.forEach((row, i) => {
        const res = results[i];
        const next = res?.ok ? res.value : null;
        // only onto the same SKILL.md: a row indexed again meanwhile (new commit) already has current flags
        if (!next || !ctx.store.setSkillRisk(row.id, row.skill_md_sha256!, next.risk_json, next.risk_level, RISK_RULES_VERSION)) return;
        got.checked++;
        if (next.risk_json !== row.risk_json || next.risk_level !== row.risk_level) got.changed++;
        if (next.minhash && setSkillMinhash(ctx.store, row.id, row.skill_md_sha256!, next.minhash)) signed.n++;
      });
    });
  }
  // rows the rules were current for but that have no signature yet (B8), at most a bounded number a day
  try {
    await minhashFillPass(ctx, signed);
  } catch (err) {
    console.warn('[minhash fill]', String((err as Error).message ?? err).slice(0, 200));
  }
  ctx.store.setSetting(RISK_RECHECK_KEY, new Date(now).toISOString());
}

/** Signatures filled per day for rows the risk re-check does not read (indexed before B8 under current rules). */
const MINHASH_FILL_MAX = 1000;

/**
 * B8 for rows with no signature that the re-check passes over (already under the current rules): reads their
 * SKILL.md at the indexed commit, and only a file with the stored hash gives the signature. MINHASH_FILL_MAX a pass,
 * so a few thousand unreadable rows (gone repos) cost a bounded number of downloads a day.
 */
async function minhashFillPass(ctx: AppContext, signed: { n: number }): Promise<void> {
  const next = ctx.store.db.prepare(
    `SELECT * FROM skills WHERE minhash IS NULL AND repo IS NOT NULL AND ref IS NOT NULL AND dir_path IS NOT NULL
       AND skill_md_sha256 IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
  );
  // goes on from where the last pass stopped, and starts over once the end is reached: read from the first id every
  // time, a thousand unreadable rows at the front (gone repos) would take each day's whole budget and the rows
  // behind them would never be signed (review 2026-11-10)
  let after = ctx.store.getSetting<string>(MINHASH_FILL_KEY) ?? '';
  let read = 0;
  while (read < MINHASH_FILL_MAX) {
    const rows = next.all(after, RISK_RECHECK_BATCH) as SkillRow[];
    if (rows.length === 0) {
      after = '';
      break;
    }
    after = rows.at(-1)!.id;
    read += rows.length;
    const results = await pool(rows, 8, async (row) => {
      await yieldToSearch();
      const r = await ctx.github.getRawText(row.repo!, row.ref!, skillMdPath(row.dir_path!));
      if (r.text == null || skillMdHash(r.text) !== row.skill_md_sha256) return null;
      return minhashBytes(skillMinhash(r.text));
    });
    ctx.store.transaction(() => {
      rows.forEach((row, i) => {
        const res = results[i];
        if (res?.ok && res.value && setSkillMinhash(ctx.store, row.id, row.skill_md_sha256!, res.value)) signed.n++;
      });
    });
  }
  ctx.store.setSetting(MINHASH_FILL_KEY, after);
}

function riskRecheckDone(ctx: AppContext, got: { checked: number; changed: number }): void {
  if (got.changed > 0) bumpIndexGeneration(ctx.store); // B1: rows whose flags changed show differently in searches
  if (got.checked > 0) console.log(`[risk recheck] ${got.checked} skills checked, ${got.changed} changed`);
}

/**
 * Checks stored skills again after the risk rules changed (RISK_RULES_VERSION): reads each SKILL.md at the
 * commit it was indexed from (raw.githubusercontent.com, not the API quota) and recomputes the flags that come
 * from the text. One pass in id order, 50 rows per transaction, stepping aside while a search runs. Rows that
 * could not be read (gone, or a different file) keep their old version and are tried on the next pass, at most
 * once a day (RISK_RECHECK_EVERY_MS) however often the app is restarted. `changed`: rows whose flags changed.
 */
export async function recheckRiskRules(ctx: AppContext, now = Date.now()): Promise<{ checked: number; changed: number }> {
  const last = ctx.store.getSetting<string>(RISK_RECHECK_KEY);
  if (riskRecheckRunning || (last && now - Date.parse(last) < RISK_RECHECK_EVERY_MS)) return { checked: 0, changed: 0 };
  riskRecheckRunning = true;
  const got = { checked: 0, changed: 0 };
  try {
    await riskRecheckPass(ctx, now, got);
  } catch (err) {
    console.warn('[risk recheck]', String((err as Error).message ?? err).slice(0, 200));
  } finally {
    riskRecheckRunning = false;
  }
  riskRecheckDone(ctx, got);
  return got;
}

/** Scheduler task "위험 규칙 재검사": as recheckRiskRules (at most once a day), but a pass that broke fails. */
export async function runRiskRecheck(ctx: AppContext): Promise<TaskOutcome> {
  const now = Date.now();
  const last = ctx.store.getSetting<string>(RISK_RECHECK_KEY);
  if (riskRecheckRunning) return { skipped: true, note: '이미 검사 중' };
  if (last && now - Date.parse(last) < RISK_RECHECK_EVERY_MS) return { skipped: true, note: '하루에 한 번' };
  riskRecheckRunning = true;
  const got = { checked: 0, changed: 0 };
  const signed = { n: 0 };
  try {
    await riskRecheckPass(ctx, now, got, signed);
  } finally {
    riskRecheckRunning = false;
    riskRecheckDone(ctx, got);
  }
  return { counts: { ...got, signed: signed.n } };
}

/**
 * Derives every stored level from its stored flags again (at startup). A change to how flags add up to a level,
 * such as a flag becoming information only (UI debate D-3), needs no download. Returns the rows that moved.
 */
export function relevelRisk(ctx: AppContext): number {
  const moved = ctx.store.listSkillRiskLevels().flatMap((r) => {
    const level = riskLevel(r.risk_json ? (JSON.parse(r.risk_json) as RiskFlag[]) : []);
    return level === r.risk_level ? [] : [{ id: r.id, level }];
  });
  for (let i = 0; i < moved.length; i += 500) {
    ctx.store.transaction(() => {
      for (const m of moved.slice(i, i + 500)) ctx.store.setSkillRiskLevel(m.id, m.level);
    });
  }
  if (moved.length > 0) {
    bumpIndexGeneration(ctx.store);
    console.log(`[risk] ${moved.length} skills got a new level from their stored signals`);
  }
  return moved.length;
}

/** Scheduler task "기록 정리": the search log (90 days), task runs (30 days) and daily star counts (90 days). */
export async function runPrune(ctx: AppContext): Promise<TaskOutcome> {
  return { counts: { searchLog: pruneSearchLog(ctx), taskRuns: schedulerFor(ctx).pruneRuns(), repoStars: pruneRepoStars(ctx.store) } };
}

/** Deletes search-log entries older than 90 days (U5-2; at startup and daily). */
export function pruneSearchLog(ctx: AppContext, now = Date.now()): number {
  try {
    return ctx.store.clearSearchLog(new Date(now - SEARCH_LOG_KEEP_MS).toISOString());
  } catch (err) {
    console.warn('[search log]', String((err as Error).message ?? err).slice(0, 200));
    return 0;
  }
}

export const POPULAR_JOB_LABEL = 'popular-repos';

/** Finds GitHub repos with many stars that hold skills and indexes them (daily after sync, or on demand). */
export function startPopularCollect(ctx: AppContext, background = false, force = false): Job {
  const running = ctx.jobs.active('collect', POPULAR_JOB_LABEL);
  if (running) return running;
  return ctx.jobs.start('collect', POPULAR_JOB_LABEL, async (ctl) => {
    await trackIndexChanges(ctx.store, () => collectPopularRepos(ctx, ctl, background, force));
  });
}

/** After a full sync: collect skills of every enabled lazy marketplace in the background (yields to searches). */
export function startAutoCollect(ctx: AppContext): void {
  for (const m of ctx.store.listMarketplaces()) {
    if (m.enabled !== 1 || m.index_mode !== 'lazy') continue;
    if (ctx.store.listPluginsNeedingIndex(m.name).length === 0) continue;
    startCollect(ctx, m.name, true);
  }
}

/** Background skill collection for a lazy marketplace; pause/resume via the job controls, restart-safe. */
export function startCollect(ctx: AppContext, marketplace: string, background = false): Job {
  const running = ctx.jobs.active('collect', marketplace);
  if (running) return running;
  return ctx.jobs.start('collect', marketplace, async (ctl) => {
    await trackIndexChanges(ctx.store, () => indexPending(ctx, marketplace, ctl, background));
  });
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The app's own background tasks, at the periods they had before the scheduler (feature review B2): the sync at
 * every start and daily, star counts every 6 hours, the risk re-check and the log pruning daily, the update check
 * every 6 hours (installed app only), and the weekly database check when nothing else runs. The popular-repo
 * collection still starts after a full sync (once a day); here it is only for "지금 실행".
 */
export function registerBuiltInTasks(): void {
  registerTask({ kind: 'sync', label: '마켓플레이스 동기화', everyMs: DAY_MS, network: true, startup: true, run: runSync });
  registerTask({
    kind: 'repo-meta',
    label: '별 정보 갱신',
    everyMs: REPO_META_EVERY_MS,
    network: true,
    startup: true,
    enabled: (ctx) => ctx.github.hasToken,
    run: runRepoMeta,
  });
  registerTask({ kind: 'risk-recheck', label: '위험 규칙 재검사', everyMs: DAY_MS, network: true, startup: true, run: runRiskRecheck });
  registerTask({ kind: 'prune', label: '기록 정리', everyMs: DAY_MS, startup: true, run: runPrune });
  registerTask({
    kind: 'update-check',
    label: '새 버전 확인',
    everyMs: UPDATE_CHECK_EVERY_MS,
    network: true,
    startup: true,
    enabled: () => process.env.SKILL_FINDER_UPDATES === '1',
    run: runUpdateCheck,
  });
  registerTask({ kind: 'db-maintenance', label: 'DB 점검', everyMs: 7 * DAY_MS, idle: true, timeoutMs: 2 * 60 * 1000, run: runDbMaintenance });
  // B8: near-copy groups from the stored signatures (local only, ~1 s for 20,000 skills)
  // idle: local and never urgent, so it waits for a moment without a search, a job or another task
  registerTask({ kind: 'clusters', label: '비슷한 사본 묶기', everyMs: HOUR_MS, startup: true, idle: true, run: runClusterRefresh });
  registerTask({
    kind: 'popular',
    label: '인기 저장소 수집',
    everyMs: DAY_MS,
    network: true,
    manualOnly: true,
    run: async (ctx) => {
      const job = startPopularCollect(ctx, true);
      await ctx.jobs.wait(job.id);
      if (job.status === 'error') throw new Error(job.errors.at(-1) ?? '수집 실패');
      return { counts: { done: job.done, total: job.total, errors: job.errors.length } };
    },
  });
}
