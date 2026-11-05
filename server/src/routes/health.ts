import { Router } from 'express';
import { SKILLS_CLI_VERSION } from '../config.ts';
import { claudeVersion } from '../claude/cli.ts';
import type { AppContext } from '../context.ts';
import { isOffline } from '../scheduler.ts';
import { updateInfo } from '../update.ts';
import { APP_VERSION } from '../version.ts';

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      /** Fixed: the launcher tells this server from any other dev server answering /api/health on the port. */
      app: 'skill-finder',
      appVersion: APP_VERSION,
      /** The server's process: `skill-finder stop` ends only the one its own pid file names. */
      pid: process.pid,
      /** A newer version on the download page (installed app only); the launcher installs it at the next start. */
      update: updateInfo(APP_VERSION),
      node: process.version,
      claudeVersion: await claudeVersion(),
      skillsCli: SKILLS_CLI_VERSION,
      githubToken: !!ctx.config.githubToken,
      /** Network errors in a row and no answer from github.com (scheduler.ts): searches use the local index only. */
      offline: isOffline(),
      plugins: ctx.store.countPlugins(),
      skills: ctx.store.countSkills(),
    });
  });
  return r;
}
