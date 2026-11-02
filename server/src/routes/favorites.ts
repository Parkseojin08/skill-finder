import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { freshInstalls, freshness, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { buildResultItem, githubSource, marketplaceSource, storeLookup, type ResultItem } from '../search/result.ts';

const FavoriteBody = z.object({ id: z.string().min(1).max(400) });

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

  /** The favorites as result cards; ones whose skill left the index are listed by name. */
  r.get('/favorites', (_req, res) => {
    const lookup = storeLookup(store);
    const items: ResultItem[] = [];
    const gone: Array<{ id: string; name: string }> = [];
    for (const f of store.listFavorites()) {
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
    res.json({ items, gone });
  });

  r.post('/favorites', (req, res) => {
    const parsed = FavoriteBody.safeParse(req.body);
    const skill = parsed.success ? store.getSkill(parsed.data.id) : undefined;
    if (!skill) return void res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
    store.addFavorite(skill.id, skill.name);
    res.json({ ok: true });
  });

  // the id in the address: some clients send no body with DELETE
  r.delete('/favorites', (req, res) => {
    const parsed = FavoriteBody.safeParse({ id: req.query.id });
    if (!parsed.success) return void res.status(400).json({ error: '스킬 id가 없습니다' });
    store.removeFavorite(parsed.data.id);
    res.json({ ok: true });
  });

  return r;
}
