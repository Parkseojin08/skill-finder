import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { searchActivity } from '../search/activity.ts';
import { RUN_FEATURES, UPDATED_WITHIN } from '../search/facets.ts';
import { runSearch, type SearchDeps, type SearchEvent } from '../search/pipeline.ts';
import { searchLogger } from '../search/searchLog.ts';
import { getSettings } from '../settings.ts';
import { searchSkillsSh } from '../sources/skillsSh.ts';
import { ndjson } from '../util/ndjson.ts';

const word = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9._+-]+$/);
/** search/facets.ts SearchFacets; values are free words of a closed alphabet (a category or license not known matches nothing). */
const Facets = z
  .object({
    trust: z.array(z.enum(['official', 'partner', 'community', 'other'])).max(4).optional(),
    category: z.array(word(40)).max(30).optional(),
    method: z.array(word(40)).max(10).optional(),
    license: z.array(word(60)).max(30).optional(),
    run: z.array(z.enum(RUN_FEATURES)).max(3).optional(),
    updated: z.enum(UPDATED_WITHIN).optional(),
    owner: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/)).max(30).optional(),
    trusted: z.boolean().optional(),
  })
  .strict();

const Body = z.object({
  query: z.string().trim().min(1).max(300),
  filters: z
    .object({
      sources: z.array(z.enum(['marketplace', 'skillssh', 'github'])).max(3).optional(),
      maxRisk: z.enum(['low', 'medium', 'high']).optional(),
      marketplaces: z.array(z.string().max(128)).max(20).optional(),
      // "별 N개 미만 숨김 · 보기": this search only, the setting stays
      minStars: z.number().int().min(0).max(10_000_000).optional(),
      // "이 조건으로 전체에서 다시 찾기" (F19): the side filters, applied before the cut
      facets: Facets.optional(),
      // "숨긴 저장소 N개 · 보기" (F20): this search only, the hidden list stays
      showHidden: z.boolean().optional(),
    })
    .optional(),
});

export function liveSearchDeps(ctx: AppContext): SearchDeps {
  return { ctx, skillsSh: (q) => searchSkillsSh(ctx.store, q, 30) };
}

export function searchRouter(ctx: AppContext, deps: SearchDeps = liveSearchDeps(ctx)): Router {
  const r = Router();
  r.post('/search', async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '검색어는 1–300자여야 합니다' });
      return;
    }
    const out = ndjson(res);
    const started = Date.now();
    const filters = parsed.data.filters ?? {};
    const log = getSettings(ctx.store).searchLog ? searchLogger(ctx.store, parsed.data.query, filters, started) : null;
    const send = (e: SearchEvent) => out.send(log ? log(e) : e);
    searchActivity.begin();
    try {
      await runSearch(deps, parsed.data.query, filters, send);
    } catch (err) {
      console.error('[search]', err);
      send({ type: 'warning', source: 'server', severity: 'urgent', message: `검색 중 오류: ${String((err as Error).message ?? err).slice(0, 200)}` });
      send({ type: 'results', items: [], hiddenHighRisk: 0, hiddenNoDescription: 0 });
      send({ type: 'done', cached: false, elapsedMs: Date.now() - started });
    } finally {
      searchActivity.end();
      out.end();
    }
  });
  return r;
}
