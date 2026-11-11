import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { ReadmeError, recommendForProject } from '../recommend/readme.ts';
import { getSettings } from '../settings.ts';

const Body = z.object({
  projectPath: z.string().trim().min(1).max(1000),
  /** Keywords turned off on the page, and words added there. */
  exclude: z.array(z.string().max(60)).max(50).optional(),
  extra: z.array(z.string().max(60)).max(20).optional(),
  /** "숨긴 저장소 N개 · 보기" (F20): this recommendation only, the hidden list stays. */
  showHidden: z.boolean().optional(),
});

/**
 * README-based recommendation: reads only `<projectPath>/README*` (≤1MB), or without one its package.json,
 * pyproject.toml or Cargo.toml, and matches the local skill index.
 */
export function recommendRouter(ctx: AppContext): Router {
  const r = Router();
  r.post('/readme-skills', (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '프로젝트 폴더 경로를 입력하세요.', code: 'INVALID_PATH' });
      return;
    }
    try {
      const { projectPath, exclude, extra, showHidden } = parsed.data;
      res.json(recommendForProject(ctx.store, projectPath, getSettings(ctx.store).weights, { exclude, extra, showHidden }));
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
