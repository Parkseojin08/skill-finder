// GET /api/agent-config: what the agents on this PC run without asking and what they approve ahead (feature review
// F10), for the 설치됨 screen's "자동 실행·권한" tab. Read only: no file is changed and nothing is started.
import { homedir } from 'node:os';
import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { readAgentConfig } from '../agentConfig/read.ts';
import { isProjectDir } from '../install/validate.ts';

/** `home`: the home folder read (tests use a temporary one); the user's own otherwise. */
export function agentConfigRouter(_ctx: AppContext, opts: { home?: string } = {}): Router {
  const r = Router();
  r.get('/agent-config', async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    if (projectPath && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    res.json(await readAgentConfig({ home: opts.home ?? homedir(), projectPath }));
  });
  return r;
}
