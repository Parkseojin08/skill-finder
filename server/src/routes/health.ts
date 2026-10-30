import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { ROOT_DIR, SKILLS_CLI_VERSION } from '../config.ts';
import { claudeVersion } from '../claude/cli.ts';
import type { AppContext } from '../context.ts';

/** The app's version from the root package.json (the release zip writes its own with the same version). */
const APP_VERSION = (() => {
  try {
    return String((JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '') || null;
  } catch {
    return null;
  }
})();

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      appVersion: APP_VERSION,
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
