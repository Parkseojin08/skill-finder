import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { recentSearches } from '../search/history.ts';

/** GET /api/history?kind=search&limit=: recent searches from the local search log (F16); empty with the log off. */
export function historyRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/history', (req, res) => {
    const kind = req.query.kind ?? 'search';
    if (kind !== 'search') {
      res.status(400).json({ error: '지원하는 기록 종류는 search뿐입니다' });
      return;
    }
    res.json({ items: recentSearches(ctx.store, Number(req.query.limit) || 10) });
  });
  return r;
}
