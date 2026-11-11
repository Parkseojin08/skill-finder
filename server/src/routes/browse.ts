import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { browse, BROWSE_TRUST, type BrowseQuery } from '../search/browse.ts';
import { CATEGORIES } from '../search/category.ts';

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const Query = z.object({
  section: z.enum(['overview', 'list', 'anthropic', 'new', 'plugins']).optional(),
  cat: z.enum(CATEGORIES).optional(),
  trust: z.enum(BROWSE_TRUST).optional(),
  marketplace: z.string().min(1).max(128).optional(),
  repo: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .optional(),
  owner: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  /** 0: this view without the star minimum ("별 기준 없이 보기"), the setting stays. */
  minStars: z.coerce.number().int().min(0).max(0).optional(),
  /** 1: this view shows the hidden repositories too (F20), the hidden list stays. */
  showHidden: z.enum(['1']).optional(),
});

/**
 * GET /api/browse?section=&cat=&trust=&marketplace=&repo=&owner=&page=&risk=&minStars=0&showHidden=1 (F17): the local index by
 * category, source, collection, newness or plugin, under the search's own limits. Without a section or filter it
 * answers the first screen's tiles with their counts.
 */
export function browseRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/browse', (req, res) => {
    const raw = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, one(v)]).filter(([, v]) => v !== '' && v != null));
    const parsed = Query.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: '둘러보기 조건이 올바르지 않습니다' });
      return;
    }
    const { section, risk, showHidden, ...rest } = parsed.data;
    const filtered = rest.cat || rest.trust || rest.marketplace || rest.repo || rest.owner;
    const q: BrowseQuery = { ...rest, section: section ?? (filtered ? 'list' : 'overview'), ...(risk ? { maxRisk: risk } : {}), ...(showHidden ? { showHidden: true } : {}) };
    res.json(browse(ctx.store, q));
  });
  return r;
}
