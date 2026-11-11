import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { deleteOwnerPref, listOwnerPrefs, normalizeOwnerKey, OwnerPrefError, setOwnerPref } from '../prefs/ownerPrefs.ts';

const Body = z.object({
  key: z.string().trim().min(1).max(141),
  kind: z.enum(['repo', 'owner']),
  pref: z.enum(['hide', 'trust']),
});

/**
 * Hidden repositories and trusted owners (F20): GET /api/prefs/owners, POST /api/prefs/owners {key, kind, pref},
 * DELETE /api/prefs/owners/:key (an `owner/repo` key with its slash encoded, `%2F`). Mounted under /api like the
 * other routers, so the security middleware (X-Skill-Finder header, same-origin writes) applies.
 */
export function prefsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/prefs/owners', (_req, res) => {
    res.json({ items: listOwnerPrefs(ctx.store) });
  });
  r.post('/prefs/owners', (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'key·kind(repo|owner)·pref(hide|trust)가 필요합니다' });
      return;
    }
    try {
      const saved = setOwnerPref(ctx.store, parsed.data.key, parsed.data.kind, parsed.data.pref);
      res.json({ saved, items: listOwnerPrefs(ctx.store) });
    } catch (err) {
      if (err instanceof OwnerPrefError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
  r.delete('/prefs/owners/:key', (req, res) => {
    const key = String(req.params.key ?? '');
    if (!normalizeOwnerKey(key, key.includes('/') ? 'repo' : 'owner')) {
      res.status(400).json({ error: '저장소(owner/repo)나 제작자 이름이 올바르지 않습니다' });
      return;
    }
    const removed = deleteOwnerPref(ctx.store, key);
    res.json({ removed, items: listOwnerPrefs(ctx.store) });
  });
  return r;
}
