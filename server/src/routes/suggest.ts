import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { suggest, SUGGEST_LIMIT, SUGGEST_MAX_QUERY } from '../search/suggest.ts';

/** GET /api/suggest?q=: names in the local index the typed text starts (F16). Local only, no network. */
export function suggestRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/suggest', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Number(req.query.limit) || SUGGEST_LIMIT;
    // longer than any name: nothing to suggest (not an error, the box sends what is typed)
    if (q.length > SUGGEST_MAX_QUERY * 3) {
      res.json({ items: [] });
      return;
    }
    res.json({ items: suggest(ctx.store, q, limit) });
  });
  return r;
}
