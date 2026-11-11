// GET /api/projects/standard (F12): a project's skills-lock.json and .claude/settings.json against what is installed.
// GET /api/projects (F13): every project the app knows of, with a line of figures each. Both read only.
import { homedir } from 'node:os';
import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { isProjectDir } from '../install/validate.ts';
import { listProjects } from '../projects/list.ts';
import { projectStandard } from '../projects/standard.ts';

/** `home`: the home folder read (tests use a temporary one); the user's own otherwise. */
export function projectsRouter(ctx: AppContext, opts: { home?: string } = {}): Router {
  const r = Router();
  const home = () => opts.home ?? homedir();

  r.get('/projects/standard', async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath.trim() : '';
    if (!isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    try {
      res.json(await projectStandard(projectPath, { home: home() }));
    } catch (err) {
      res.status(500).json({ error: `프로젝트 표준을 읽지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });

  r.get('/projects', async (req, res) => {
    try {
      res.json(await listProjects(ctx.store, { home: home() }, req.query.fresh === '1'));
    } catch (err) {
      res.status(500).json({ error: `프로젝트 목록을 읽지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });

  return r;
}
