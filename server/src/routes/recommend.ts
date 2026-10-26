import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { ReadmeError, recommendForProject } from '../recommend/readme.ts';
import { getSettings } from '../settings.ts';

const Body = z.object({ projectPath: z.string().trim().min(1).max(1000) });

/** README-based recommendation: reads only `<projectPath>/README*` (≤1MB) and matches the local skill index. */
export function recommendRouter(ctx: AppContext): Router {
  const r = Router();
  r.post('/readme-skills', (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '프로젝트 폴더 경로를 입력하세요.', code: 'INVALID_PATH' });
      return;
    }
    try {
      res.json(recommendForProject(ctx.store, parsed.data.projectPath, getSettings(ctx.store).weights));
    } catch (err) {
      if (err instanceof ReadmeError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });
  return r;
}
