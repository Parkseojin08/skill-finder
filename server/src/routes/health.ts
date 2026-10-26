import { Router } from 'express';
import { SKILLS_CLI_VERSION } from '../config.ts';
import { claudeVersion } from '../claude/cli.ts';
import type { AppContext } from '../context.ts';

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      node: process.version,
      claudeVersion: await claudeVersion(),
      skillsCli: SKILLS_CLI_VERSION,
      githubToken: !!ctx.config.githubToken,
      plugins: ctx.store.countPlugins(),
      skills: ctx.store.countSkills(),
    });
  });
  return r;
}
