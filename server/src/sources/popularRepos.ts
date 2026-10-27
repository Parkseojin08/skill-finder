import type { AppContext } from '../context.ts';
import type { JobControl } from '../jobs.ts';
import { searchActivity } from '../search/activity.ts';
import { getSettings } from '../settings.ts';
import { pool, sleep } from '../util/limiter.ts';

/**
 * Popular-repo collection: the search's minimum-stars filter (default 5,000) left few results because most
 * candidates come from small repos. This finds well-starred repos that hold skills via GitHub repository
 * search (which, unlike code search, filters by stars) and indexes their skills locally, so local search
 * has plenty of candidates that pass the filter.
 */

/** Repository-search terms; each runs with `stars:>=<minimum>`. Topic and keyword searches cover different repos. */
const QUERIES = [
  'topic:claude-skills',
  'topic:agent-skills',
  'topic:claude-code-skills',
  'topic:claude-code',
  'topic:anthropic-claude',
  '"claude skills"',
  '"agent skills"',
  'claude code skills',
  'SKILL.md in:readme',
];

const STATE_KEY = 'popularRepos';
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPOS = 150;
/** Without a star filter the search would be every repo with a matching topic; keep a floor. */
const MIN_STARS_FLOOR = 1000;

type State = { lastRunAt: string | null; repos: Record<string, { checkedAt: string; skills: number }> };

export function popularState(ctx: AppContext): State {
  return ctx.store.getSetting<State>(STATE_KEY) ?? { lastRunAt: null, repos: {} };
}

export async function collectPopularRepos(ctx: AppContext, ctl: JobControl, background: boolean, force: boolean): Promise<void> {
  const minStars = Math.max(MIN_STARS_FLOOR, getSettings(ctx.store).minStars);
  const state = popularState(ctx);

  // 1. find repos (sequential: the search API allows 30 requests a minute)
  const found = new Map<string, number>();
  for (const q of QUERIES) {
    await ctl.checkpoint();
    try {
      for (const r of await ctx.github.searchRepos(`${q} stars:>=${minStars}`)) found.set(r.repo, Math.max(found.get(r.repo) ?? 0, r.stars));
    } catch (err) {
      ctl.tick(`검색 "${q}": ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  const now = Date.now();
  const due = [...found]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REPOS)
    .map(([repo]) => repo)
    .filter((repo) => force || !state.repos[repo] || now - Date.parse(state.repos[repo].checkedAt) > RECHECK_MS);
  ctl.addTotal(due.length);

  // 2. index their skills (yields to searches when running in the background)
  await pool(
    due,
    background ? 3 : 4,
    async (repo) => {
      await ctl.checkpoint();
      while (background && searchActivity.busy() && !ctl.cancelled) await sleep(500);
      try {
        const skills = await ctx.indexer.indexRepo(repo);
        state.repos[repo] = { checkedAt: new Date().toISOString(), skills };
        ctl.tick();
      } catch (err) {
        ctl.tick(`${repo}: ${String((err as Error).message ?? err).slice(0, 200)}`);
      }
    },
    () => ctl.cancelled,
  );
  state.lastRunAt = new Date().toISOString();
  ctx.store.setSetting(STATE_KEY, state);
}
