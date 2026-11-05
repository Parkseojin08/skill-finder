// The status view (feature review F22): how fresh each source of the index is, GitHub's quotas, the background
// tasks and their recent runs, and whether the app is offline. Plus the light activity poll behind the menu bar's
// task indicator, "지금 실행", the masked log, and the token check run after a token is saved.
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { constants, gunzipSync } from 'node:zlib';
import { Router } from 'express';
import { RISK_RULES_VERSION } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import { SEED_PATH } from '../db/seed.ts';
import { networkState, schedulerFor, type TaskRunRow } from '../scheduler.ts';
import { popularState } from '../sources/popularRepos.ts';
import { MODEL_LANGS } from '../translate/models.ts';
import { logFilePath, logTail, maskSecrets } from '../util/log.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A marketplace not synced for this long makes the index "오래됨". */
export const MARKET_STALE_MS = 2 * DAY_MS;
const LIMIT_RESOURCES = ['core', 'search', 'code_search', 'graphql'] as const;

export type Limit = { resource: string; remaining: number | null; limit: number | null; reset: number | null };

// ---- GitHub quotas: read from the GitHub client (sources/github.ts keeps them; this file only reads)

type GithubLimitsSource = {
  rateLimits?: () => Array<{ resource: string; remaining: number; reset: number; limit?: number }> | Map<string, { remaining: number; reset: number }>;
  limits?: Map<string, { remaining: number; reset: number; limit?: number }>;
};

/** The last /rate_limit answer of a token check: fills in quotas the app has not used since it started. */
let checkedLimits: { at: number; limits: Limit[] } | null = null;

export function githubLimits(ctx: AppContext): Limit[] {
  const src = ctx.github as unknown as GithubLimitsSource;
  const live = new Map<string, { remaining: number; reset: number; limit?: number }>();
  const got = typeof src.rateLimits === 'function' ? src.rateLimits() : src.limits;
  if (got instanceof Map) for (const [k, v] of got) live.set(k, v);
  else if (Array.isArray(got)) for (const v of got) live.set(v.resource, v);
  const checked = new Map((checkedLimits?.limits ?? []).map((l) => [l.resource, l] as const));
  return LIMIT_RESOURCES.map((resource) => {
    const l = live.get(resource);
    const c = checked.get(resource);
    if (l) return { resource, remaining: l.remaining, limit: l.limit ?? c?.limit ?? null, reset: l.reset || null };
    return c ?? { resource, remaining: null, limit: null, reset: null };
  });
}

// ---- token check

export type TokenCheck = {
  state: 'valid' | 'invalid' | 'unknown' | 'none';
  kind: 'classic' | 'fine-grained' | 'other' | null;
  /** core requests per hour, and how many are left */
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  /** classic tokens only: what GitHub says they may do */
  scopes: string[] | null;
  /** a classic token with any scope: more than the public read access this app needs */
  broad: boolean;
  error: string | null;
};

const tokenKind = (t: string): TokenCheck['kind'] => (t.startsWith('github_pat_') ? 'fine-grained' : t.startsWith('ghp_') ? 'classic' : 'other');

/**
 * Asks GitHub's /rate_limit with the token: it says whether the token works, the hourly quota and what is left, and
 * does not use any of it. Classic tokens also send their scopes (x-oauth-scopes).
 */
export async function checkGithubToken(token: string | null, fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
  const base: TokenCheck = { state: 'none', kind: null, limit: null, remaining: null, reset: null, scopes: null, broad: false, error: null };
  if (!token) return base;
  const kind = tokenKind(token);
  try {
    const res = await fetchImpl('https://api.github.com/rate_limit', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'skill-finder', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      return { ...base, state: 'invalid', kind, error: 'GitHub가 토큰을 받지 않았습니다 (401)' };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ...base, state: 'unknown', kind, error: `GitHub 응답 ${res.status}` };
    }
    const body = (await res.json()) as { resources?: Record<string, { limit?: number; remaining?: number; reset?: number }> };
    const header = res.headers.get('x-oauth-scopes');
    const scopes = header == null ? null : header.split(',').map((s) => s.trim()).filter(Boolean);
    const core = body.resources?.core ?? {};
    checkedLimits = {
      at: Date.now(),
      limits: LIMIT_RESOURCES.map((r) => {
        const v = body.resources?.[r];
        return { resource: r, remaining: v?.remaining ?? null, limit: v?.limit ?? null, reset: v?.reset ?? null };
      }),
    };
    return {
      ...base,
      state: 'valid',
      kind: scopes != null && kind === 'other' ? 'classic' : kind,
      limit: core.limit ?? null,
      remaining: core.remaining ?? null,
      reset: core.reset ?? null,
      scopes,
      broad: !!scopes && scopes.length > 0,
    };
  } catch (err) {
    return { ...base, state: 'unknown', kind, error: maskSecrets(String((err as Error).message ?? err)).slice(0, 200) };
  }
}

/** Tests replace the fetch the token check uses. */
export const tokenCheckDeps: { fetch: typeof fetch | null } = { fetch: null };

// ---- freshness

let seedDate: { path: string; mtimeMs: number; createdAt: string | null } | null = null;

/** When the shipped index was made: read from the first bytes of the gzip file (its `createdAt` comes first). */
export function seedCreatedAt(path = SEED_PATH): string | null {
  if (!existsSync(path)) return null;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (seedDate && seedDate.path === path && seedDate.mtimeMs === mtimeMs) return seedDate.createdAt;
    const buf = Buffer.alloc(4096);
    const fd = openSync(path, 'r');
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    const head = gunzipSync(buf.subarray(0, n), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8', 0, 512);
    const m = /"createdAt"\s*:\s*"([0-9T:.\-Z]{10,30})"/.exec(head);
    const createdAt = m ? m[1]! : new Date(mtimeMs).toISOString();
    seedDate = { path, mtimeMs, createdAt };
    return createdAt;
  } catch {
    return null;
  }
}

type AgeBuckets = { total: number; never: number; day: number; week: number; month: number; older: number };

function ageBuckets(ctx: AppContext, sql: string, now: number, ...args: string[]): AgeBuckets {
  const day = new Date(now - DAY_MS).toISOString();
  const week = new Date(now - 7 * DAY_MS).toISOString();
  const month = new Date(now - 30 * DAY_MS).toISOString();
  const r = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(at IS NULL) AS never, SUM(at >= ?) AS day, SUM(at < ? AND at >= ?) AS week,
         SUM(at < ? AND at >= ?) AS month, SUM(at < ?) AS older FROM (${sql})`,
    )
    .get(day, day, week, week, month, month, ...args) as Record<string, number | null>;
  const n = (k: string) => Number(r[k] ?? 0);
  return { total: n('total'), never: n('never'), day: n('day'), week: n('week'), month: n('month'), older: n('older') };
}

export type FreshnessReason =
  | { code: 'marketNeverSynced' | 'marketStale'; name: string }
  | { code: 'starsStale'; percent: number }
  | { code: 'taskFailing'; kind: string; label: string; failCount: number }
  | { code: 'offline' };

export function buildStatus(ctx: AppContext, now = Date.now()) {
  const store = ctx.store;
  const scheduler = schedulerFor(ctx);
  const marketplaces = store.listMarketplaces().map((m) => ({
    name: m.name,
    repo: m.repo,
    enabled: m.enabled === 1,
    syncedAt: m.synced_at,
    commit: m.commit_sha,
    pluginCount: m.plugin_count,
    error: m.error,
  }));
  const enabled = JSON.stringify(marketplaces.filter((m) => m.enabled).map((m) => m.name));
  const pluginIndex = ageBuckets(
    ctx,
    'SELECT skills_indexed_at AS at FROM plugins WHERE marketplace IN (SELECT value FROM json_each(?))',
    now,
    enabled,
  );
  const stars = ageBuckets(
    ctx,
    'SELECT fetched_at AS at FROM repos WHERE lower(full_name) IN (SELECT lower(repo) FROM skills WHERE repo IS NOT NULL)',
    now,
  );
  const oldRiskRules = Number(
    (store.db.prepare('SELECT COUNT(*) AS n FROM skills WHERE risk_rules IS NULL OR risk_rules < ?').get(RISK_RULES_VERSION) as { n: number }).n,
  );
  const popular = popularState(ctx);
  const popularRepos = Object.values(popular.repos);
  const translate = MODEL_LANGS.map((lang) => {
    const s = ctx.translateModels.status(lang);
    return { lang, state: s.state, error: s.error };
  });
  const tasks = scheduler.view();
  const network = networkState();

  const reasons: FreshnessReason[] = [];
  for (const m of marketplaces) {
    if (!m.enabled) continue;
    if (!m.syncedAt) reasons.push({ code: 'marketNeverSynced', name: m.name });
    else if (now - Date.parse(m.syncedAt) > MARKET_STALE_MS) reasons.push({ code: 'marketStale', name: m.name });
  }
  if (ctx.github.hasToken && stars.total > 0) {
    // older than a week (or never read): the refresh runs every 6 hours, so with a token few rows should be
    const percent = Math.round(((stars.never + stars.month + stars.older) / stars.total) * 100);
    if (percent > 20) reasons.push({ code: 'starsStale', percent });
  }
  for (const t of tasks) if (t.failCount >= 2) reasons.push({ code: 'taskFailing', kind: t.kind, label: t.label, failCount: t.failCount });
  if (network.offline) reasons.push({ code: 'offline' });

  const nextDue = tasks
    .filter((t) => !t.manualOnly && !t.running && !(t.network && network.offline))
    .map((t) => ({ kind: t.kind, label: t.label, at: t.nextDueAt }))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))[0] ?? null;

  return {
    now: new Date(now).toISOString(),
    freshness: { level: reasons.length ? ('stale' as const) : ('good' as const), reasons },
    network,
    sources: {
      marketplaces,
      pluginIndex,
      stars,
      oldRiskRules,
      riskRulesVersion: RISK_RULES_VERSION,
      seedCreatedAt: seedCreatedAt(),
      popular: {
        lastRunAt: popular.lastRunAt,
        repos: popularRepos.length,
        withSkills: popularRepos.filter((r) => r.skills > 0).length,
        skills: popularRepos.reduce((n, r) => n + r.skills, 0),
      },
      translate,
    },
    github: { hasToken: ctx.github.hasToken, limits: githubLimits(ctx), checkedAt: checkedLimits ? new Date(checkedLimits.at).toISOString() : null },
    tasks,
    nextDue,
    running: scheduler.runningView(),
    runs: scheduler.recentRuns(30).map(runView),
  };
}

function runView(r: TaskRunRow) {
  let counts: Record<string, number> | null = null;
  try {
    counts = r.counts_json ? (JSON.parse(r.counts_json) as Record<string, number>) : null;
  } catch {
    counts = null;
  }
  return { id: r.id, kind: r.kind, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, counts, error: r.error };
}

// ---- log

export type LogLevel = 'info' | 'warn' | 'error';
const LEVEL_RANK: Record<string, number> = { INFO: 0, WARN: 1, ERROR: 2 };
const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) (INFO|WARN|ERROR) /;

/**
 * The log's entries at `level` or above, the last `lines` of them. A message over several lines (a stack) stays one
 * entry. The log is masked when written; it is masked once more here (a token saved since).
 */
export function readLog(level: LogLevel, lines: number): Array<{ at: string; level: string; text: string }> {
  return parseLog(logTail(Math.max(lines * 20, 2000)), level, lines);
}

export function parseLog(text: string, level: LogLevel, lines: number): Array<{ at: string; level: string; text: string }> {
  const min = LEVEL_RANK[level.toUpperCase()] ?? 1;
  const entries: Array<{ at: string; level: string; text: string }> = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) entries.push({ at: m[1]!, level: m[2]!, text: line.slice(m[0].length) });
    else if (entries.length && line) entries[entries.length - 1]!.text += `\n${line}`;
  }
  return entries
    .filter((e) => (LEVEL_RANK[e.level] ?? 0) >= min)
    .slice(-lines)
    .map((e) => ({ ...e, text: maskSecrets(e.text).slice(0, 4000) }));
}

export function statusRouter(ctx: AppContext): Router {
  const r = Router();
  const scheduler = schedulerFor(ctx);

  r.get('/status', (_req, res) => {
    res.json(buildStatus(ctx));
  });

  // the menu bar's indicator and every screen's job list: one light poll (web/src/activity.ts)
  r.get('/activity', (_req, res) => {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    res.json({
      jobs: ctx.jobs.list(),
      running: scheduler.runningView(),
      network: networkState(),
      failures: scheduler.recentRuns(3, { failedOnly: true, sinceIso: since }).map(runView),
    });
  });

  r.post('/tasks/:kind/run', (req, res) => {
    const started = scheduler.runNow(req.params.kind);
    if (started === null) {
      res.status(404).json({ error: '알 수 없는 작업입니다' });
      return;
    }
    if (started === 'running') {
      res.status(409).json({ error: '이미 실행 중입니다' });
      return;
    }
    res.status(202).json({ runId: started.runId });
  });

  r.get('/logs', (req, res) => {
    const level = (['info', 'warn', 'error'] as const).find((l) => l === req.query.level) ?? 'warn';
    const n = Math.min(1000, Math.max(1, Math.floor(Number(req.query.lines) || 200)));
    res.json({ path: logFilePath(), level, entries: readLog(level, n) });
  });

  // after a token is saved (the settings screen calls this; the token itself is never sent back)
  r.post('/github-token/check', async (_req, res) => {
    res.json(await checkGithubToken(ctx.config.githubToken, tokenCheckDeps.fetch ?? fetch));
  });

  return r;
}
