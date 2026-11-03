import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { freshInstalls, freshness, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { installSummary } from '../install/summary.ts';
import { isRepo } from '../install/validate.ts';
import { buildResultItem, githubSource, marketplaceSource, storeLookup, type RepoResult, type ResultItem } from '../search/result.ts';
import { sanitizeLine } from '../util/sanitize.ts';

const FavoriteBody = z.object({ id: z.string().min(1).max(400) });
/**
 * `name`: a search result not in the index yet (still being checked) is kept by it until it is. Unusable (empty,
 * not text) it is left out rather than refused, so an indexed skill still gets its star.
 */
const FavoriteAdd = FavoriteBody.extend({ name: z.unknown().optional(), repo: z.unknown().optional() });
const usableName = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

/** A favorite GitHub repository (user request 2026-11-03): `repo:` and the name in lower case, so one per repo. */
const REPO_PREFIX = 'repo:';
type RepoMeta = { description: string | null; topics: string[] };
/** What the search showed of the repo; anything unusable is left out rather than refused. */
function repoMeta(v: unknown): RepoMeta {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const description = typeof o.description === 'string' && o.description.trim() ? sanitizeLine(o.description).slice(0, 500) : null;
  const topics = Array.isArray(o.topics) ? o.topics.filter((x): x is string => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,49}$/.test(x)).slice(0, 30) : [];
  return { description, topics };
}
/** One damaged row must not take the whole favorites list down with it. */
function parseJson(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * This PC's favorite skills (user decision 2026-11-02). No accounts: the app runs for one person on 127.0.0.1, so a
 * login kept only here protected nothing. The API's header and same-origin checks apply as everywhere.
 */
export function favoritesRouter(ctx: AppContext): Router {
  const r = Router();
  const { store } = ctx;

  r.get('/favorites/ids', (_req, res) => {
    res.json({ ids: store.listFavorites().map((f) => f.skill_id) });
  });

  /** The favorites as result cards and repository cards; skills that left the index are listed by name. */
  r.get('/favorites', (_req, res) => {
    const lookup = storeLookup(store);
    const items: ResultItem[] = [];
    const repos: RepoResult[] = [];
    const gone: Array<{ id: string; name: string }> = [];
    for (const f of store.listFavorites()) {
      if (f.skill_id.startsWith(REPO_PREFIX)) {
        const repo = f.skill_name;
        const meta = repoMeta(parseJson(f.meta_json));
        repos.push({
          repo,
          url: `https://github.com/${repo}`,
          ...meta,
          stars: store.getRepo(repo)?.stars ?? null,
          // as the search's repository card lists them
          skills: store
            .findSkillsByRepo(repo)
            .filter((s) => s.description && s.origin !== 'wellknown')
            .slice(0, 30)
            .map((s) => installSummary(s, lookup)),
        });
        continue;
      }
      const s = store.getSkill(f.skill_id);
      if (!s) {
        gone.push({ id: f.skill_id, name: f.skill_name });
        continue;
      }
      const plugin = lookup.plugin(s.plugin_id);
      const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
      const breakdown = { R: 0, P: 0, F: freshness(s.last_commit_at), T: TRUST_SCORE[trustTier(s, plugin)] };
      items.push(
        buildResultItem({ skill: s, lookup, sources: source ? [source] : [], installs: freshInstalls(s), stars: s.repo ? (store.getRepo(s.repo)?.stars ?? null) : null, breakdown, score: 0 }),
      );
    }
    res.json({ items, repos, gone });
  });

  r.post('/favorites', (req, res) => {
    const parsed = FavoriteAdd.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: '스킬 id가 없습니다' });
    if (parsed.data.id.startsWith(REPO_PREFIX)) {
      const repo = parsed.data.id.slice(REPO_PREFIX.length);
      if (!isRepo(repo)) return void res.status(400).json({ error: '저장소 이름이 올바르지 않습니다' });
      // the name as GitHub writes it (morluto/rea), when it is a repo name and the same repo
      const name = usableName(parsed.data.name);
      store.addFavorite(REPO_PREFIX + repo.toLowerCase(), isRepo(name) && name.toLowerCase() === repo.toLowerCase() ? name : repo, repoMeta(parsed.data.repo));
      return void res.json({ ok: true });
    }
    const skill = store.getSkill(parsed.data.id);
    // not indexed: listed by name on the favorites page, as a card once the index has it
    const name = skill?.name ?? usableName(parsed.data.name);
    if (!name) return void res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
    store.addFavorite(parsed.data.id, name);
    res.json({ ok: true });
  });

  // the id in the address: some clients send no body with DELETE
  r.delete('/favorites', (req, res) => {
    const parsed = FavoriteBody.safeParse({ id: req.query.id });
    if (!parsed.success) return void res.status(400).json({ error: '스킬 id가 없습니다' });
    // repository favorites are kept in lower case (POST)
    store.removeFavorite(parsed.data.id.startsWith(REPO_PREFIX) ? parsed.data.id.toLowerCase() : parsed.data.id);
    res.json({ ok: true });
  });

  return r;
}
