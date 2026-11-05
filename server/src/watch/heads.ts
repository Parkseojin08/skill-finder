// Repository HEAD watch (feature review B3): repos whose default branch moved past the commit their skills were
// indexed at are indexed again, so installed and favorite skills compare against current text (F6) and their
// changes are written as notices (F7). Registered with the scheduler by the platform piece (see the stage-2 report).
import type { AppContext } from '../context.ts';
import { installedPluginEntries, scanInstalledSkills } from '../install/installed.ts';
import { isProjectDir } from '../install/validate.ts';
import { searchActivity } from '../search/activity.ts';
import { trackIndexChanges } from '../search/indexGeneration.ts';
import { getSettings } from '../settings.ts';
import { sleep } from '../util/limiter.ts';
import {
  addNotice,
  noteRepoChange,
  noticeWatchedChanges,
  PLUGIN_NOTICE,
  rememberInstalled,
  repoHeadSha,
  setRepoHeadSha,
  watchedRepos,
  watchedSkills,
} from './notices.ts';

/** Setting: the head commit each repo was last indexed at by this watch (lower-case name → sha). */
const HEADS_KEY = 'watch.heads';
/** Repos nobody installed or starred that one run indexes again at most (the rest wait for the next run). */
export const REST_PER_RUN = 100;
/** Recently opened skills' repos (the detail view's `view` events) come third, from this far back. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_MAX = 50;

let running = false;

export type HeadWatchOptions = {
  /** The home folder whose `.claude` is read (tests); the user's own otherwise. */
  home?: string;
  restLimit?: number;
};

type Target = { repo: string; tier: 'installed' | 'favorite' | 'recent' | 'rest' };

/**
 * What is installed on this PC as far as Claude Code is concerned: skill folders (personal, the app's project folders
 * and the default project folder) and plugins from `installed_plugins.json`, remembered for the notices.
 */
async function scanInstalled(ctx: AppContext, home?: string): Promise<{ skillIds: string[]; pluginIds: string[] }> {
  const { store } = ctx;
  const skillIds: string[] = [];
  const projects = new Set<string>();
  for (const p of store.listInstalledProjects(20)) projects.add(p);
  const def = getSettings(store).defaultProjectPath;
  if (isProjectDir(def)) projects.add(def);
  const rows = [
    ...(await scanInstalledSkills(store, 'user', null, undefined, { agents: 'claude', home })),
    ...(await Promise.all([...projects].map((p) => scanInstalledSkills(store, 'project', p, undefined, { agents: 'claude', home }).catch(() => [])))).flat(),
  ];
  for (const r of rows) if (r.skillId) skillIds.push(r.skillId);
  const plugins = installedPluginEntries(home);
  const pluginIds = [...new Set(plugins.map((p) => p.id))];
  return { skillIds, pluginIds };
}

/** Repos with skills the generic indexer wrote (marketplace plugins' rows are kept current by the sync instead). */
function hasGenericSkills(ctx: AppContext, repo: string): boolean {
  return !!ctx.store.db.prepare("SELECT 1 FROM skills WHERE repo = ? COLLATE NOCASE AND origin = 'generic' LIMIT 1").get(repo);
}

/** Whether some generic row of the repo was indexed at another commit than `head`. */
function behindHead(ctx: AppContext, repo: string, head: string): boolean {
  return !!ctx.store.db.prepare("SELECT 1 FROM skills WHERE repo = ? COLLATE NOCASE AND origin = 'generic' AND ref IS NOT ? LIMIT 1").get(repo, head);
}

/** Repos opened recently in the detail view, newest first. */
function recentRepos(ctx: AppContext): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT s.repo AS repo, MAX(e.id) AS last FROM events e JOIN skills s ON s.id = e.skill_id
        WHERE e.kind = 'view' AND e.created_at > ? AND s.repo IS NOT NULL GROUP BY lower(s.repo) ORDER BY last DESC LIMIT ?`,
    )
    .all(new Date(Date.now() - RECENT_MS).toISOString(), RECENT_MAX) as Array<{ repo: string }>;
  return rows.map((r) => r.repo);
}

/** Repos whose stored head (from the metadata refresh) is ahead of some of their generic rows, most stars first. */
function staleRepos(ctx: AppContext, limit: number): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT r.full_name AS repo FROM repos r WHERE r.head_sha IS NOT NULL
         AND EXISTS (SELECT 1 FROM skills s WHERE s.repo = r.full_name COLLATE NOCASE AND s.origin = 'generic' AND s.ref IS NOT r.head_sha)
       ORDER BY r.stars DESC LIMIT ?`,
    )
    .all(limit) as Array<{ repo: string }>;
  return rows.map((r) => r.repo);
}

/**
 * B3 "저장소 변경 확인": installed → favorite → recently opened → the rest, each repo indexed again only when its
 * default branch is at another commit than the one indexed. Installed and favorite repos are asked fresh (the API
 * with a token, `git ls-remote` without, D#6d35); the others use the head the metadata refresh stored, and are
 * skipped without a token. Steps aside while a search runs. Then installed plugins are compared with their
 * marketplace's commit, and the watched skills' rows with the last pass (notices, F7).
 */
export async function runRepoHeadWatch(ctx: AppContext, opts: HeadWatchOptions = {}): Promise<{ counts?: Record<string, number> }> {
  if (running) return { counts: { skipped: 1 } };
  running = true;
  const counts = { repos: 0, reindexed: 0, unchanged: 0, failed: 0, gone: 0, notices: 0, plugins: 0 };
  try {
    const { store } = ctx;
    const installed = await scanInstalled(ctx, opts.home);
    rememberInstalled(store, installed.skillIds, installed.pluginIds);
    const skills = watchedSkills(store);
    const watched = watchedRepos(store, skills);
    // the rows as they are before this run reads anything (on the first run, the snapshot this run's changes are
    // compared with; later, what other paths such as a search lookup changed meanwhile)
    counts.notices += noticeWatchedChanges(store, { skills }).notices;

    const seen = new Set<string>();
    const targets: Target[] = [];
    const push = (repo: string, tier: Target['tier']) => {
      const key = repo.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ repo, tier });
    };
    for (const w of watched.values()) if (w.why.has('installed')) push(w.repo, 'installed');
    for (const w of watched.values()) if (w.why.has('favorite')) push(w.repo, 'favorite');
    if (ctx.github.hasToken) {
      for (const r of recentRepos(ctx)) push(r, 'recent');
      for (const r of staleRepos(ctx, opts.restLimit ?? REST_PER_RUN)) push(r, 'rest');
    }

    const heads = store.getSetting<Record<string, string>>(HEADS_KEY) ?? {};
    const vanished = new Set<string>();
    await trackIndexChanges(store, async () => {
      for (const { repo, tier } of targets) {
        // yields to searches, but not forever: a search left marked busy must not hold the task (review 2026-11-05)
        for (let waited = 0; searchActivity.busy() && waited < 120_000; waited += 500) await sleep(500);
        if (!hasGenericSkills(ctx, repo)) continue;
        counts.repos++;
        const key = repo.toLowerCase();
        const fresh = tier === 'installed' || tier === 'favorite';
        const head = fresh ? ((await ctx.github.resolveRef(repo, null).catch(() => null))?.sha ?? null) : repoHeadSha(store, repo);
        if (!head) {
          // ls-remote fails the same way for a network problem; only a definite "not there" counts as gone
          if (fresh && (await ctx.github.repoExists(repo)) === false) {
            counts.gone++;
            counts.notices += noteRepoChange(store, watched, repo, store.getRepo(repo), { gone: true });
          } else counts.failed++;
          continue;
        }
        if (fresh) setRepoHeadSha(store, repo, head);
        const indexedAt = heads[key] ?? (behindHead(ctx, repo, head) ? null : head);
        if (indexedAt === head) {
          heads[key] = head;
          counts.unchanged++;
          continue;
        }
        try {
          const r = await ctx.indexer.indexRepo(repo, { unchangedSince: indexedAt });
          if (r.unchanged) counts.unchanged++;
          else counts.reindexed++;
          if (r.sha) {
            heads[key] = r.sha;
            // a watched skill the new commit no longer has keeps its row while installed: it is gone from the repo
            for (const id of watched.get(key)?.skillIds ?? []) {
              const row = store.getSkill(id);
              if (row?.origin === 'generic' && row.ref !== r.sha) vanished.add(id);
            }
          }
        } catch (err) {
          counts.failed++;
          if (fresh && /찾을 수 없습니다/.test(String((err as Error)?.message ?? err)) && (await ctx.github.repoExists(repo)) === false) {
            counts.gone++;
            counts.notices += noteRepoChange(store, watched, repo, store.getRepo(repo), { gone: true });
          }
        }
      }
    });
    store.setSetting(HEADS_KEY, heads);

    counts.plugins = notePluginPins(ctx, opts.home);
    counts.notices += counts.plugins;
    counts.notices += noticeWatchedChanges(store, { vanished, skills }).notices;
  } finally {
    running = false;
  }
  return { counts };
}

/**
 * Installed plugins whose marketplace now points at another commit than the one Claude Code installed: one notice
 * per install and commit, with how many of the skills that `claude plugin update` would bring are high risk.
 */
function notePluginPins(ctx: AppContext, home?: string): number {
  let n = 0;
  for (const e of installedPluginEntries(home)) {
    const plugin = ctx.store.getPlugin(e.id);
    const to = plugin?.skills_indexed_sha;
    if (!e.gitCommitSha || !to || to === e.gitCommitSha) continue;
    const high = ctx.store.listSkillsByPlugin(e.id).filter((s) => s.risk_level === 'high').map((s) => s.name);
    n += Number(
      addNotice(ctx.store, {
        skillId: `${PLUGIN_NOTICE}${e.id}`,
        kind: 'new_commit',
        from: e.gitCommitSha,
        to,
        detail: { name: e.id, plugin: e.id, scope: e.scope, projectPath: e.projectPath, highRisk: high.length, highSkills: high.slice(0, 10), watch: ['installed'], skillIds: ctx.store.listSkillsByPlugin(e.id).map((s) => s.id) },
      }),
    );
  }
  return n;
}

/**
 * Notices only (no network): the watched skills' rows against the last pass. For after the risk re-check and the
 * repo metadata refresh, whose changes otherwise wait for the next head watch.
 */
export async function runNoticeCheck(ctx: AppContext): Promise<{ counts?: Record<string, number> }> {
  const r = noticeWatchedChanges(ctx.store);
  return { counts: { notices: r.notices, watched: r.watched } };
}
