// POST /api/lint-skill {path, projectPath?} (feature review F15): "검사" on a 설치됨 row the index does not know (a
// skill written here). Only such a folder is read: one directly under an agent's skill folder of agents.ts (the
// places the 설치됨 screen lists, user or project), found by that screen's own scan with no index row. `..`, other
// places and a link leading out of the agents' folders are refused. Nothing is written or run.
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { agentFolders, AGENTS } from '../install/agents.ts';
import { pathKey, scanInstalledSkills, type InstalledSkill } from '../install/installed.ts';
import { isProjectDir } from '../install/validate.ts';
import { lintSkillFolder } from '../lint/lint.ts';
import { getSettings } from '../settings.ts';

export type LintTarget = { scope: 'user' | 'project'; projectPath: string | null; row: InstalledSkill };
export type LintRefusal = { status: number; error: string };

const real = async (p: string) => pathKey(await realpath(p).catch(() => p));

/**
 * The installed skill a path names, as the 설치됨 screen lists it: the user's agent folders, or a project's (the one
 * given, else the one the path sits in). A refusal says why not.
 */
export async function findLintTarget(store: AppContext['store'], path: unknown, projectPath: unknown, home = homedir()): Promise<LintTarget | LintRefusal> {
  if (typeof path !== 'string' || !path || path.length > 1000 || !isAbsolute(path) || /[\0\r\n]/.test(path)) return { status: 400, error: '스킬 폴더의 절대경로가 필요합니다' };
  if (path.split(/[\\/]+/).includes('..')) return { status: 400, error: '경로에 ..를 쓸 수 없습니다' };
  if (projectPath != null && projectPath !== '' && !isProjectDir(projectPath)) return { status: 400, error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' };
  const target = resolve(path);
  const parent = pathKey(dirname(target));
  const folder = basename(target);

  // where the folder may be: the user's agent folders, the project given, or the project its path is in
  const places: Array<{ scope: 'user' | 'project'; root: string }> = [{ scope: 'user', root: home }];
  if (typeof projectPath === 'string' && projectPath) places.push({ scope: 'project', root: projectPath });
  else {
    // the parent as written (pathKey only changes case and slashes and drops a trailing one, so the lengths agree):
    // the answer's projectPath keeps the folder's own spelling instead of a lower-case one
    const parentAsWritten = dirname(target).replace(/\//g, '\\').replace(/\\+$/, '');
    for (const rel of new Set(AGENTS.map((a) => a.projectDir))) {
      const tail = pathKey(`${sep}${rel}`);
      if (parent.endsWith(tail)) {
        const root = parentAsWritten.length === parent.length ? parentAsWritten.slice(0, -tail.length) : parent.slice(0, -tail.length);
        if (root && isProjectDir(root)) places.push({ scope: 'project', root });
      }
    }
  }
  const realTarget = await real(target);
  for (const { scope, root } of places) {
    const dirs = agentFolders(scope, root).map((f) => f.dir);
    if (!dirs.some((d) => pathKey(d) === parent)) continue;
    // a link may lead to another agent's folder (the skills CLI links them), never anywhere else
    const realDirs = await Promise.all(dirs.map(real));
    if (!realDirs.some((d) => pathKey(dirname(realTarget)) === d)) return { status: 403, error: '에이전트 스킬 폴더 밖을 가리키는 링크는 검사하지 않습니다' };
    const projectRoot = scope === 'project' ? root : null;
    const rows = await scanInstalledSkills(store, scope, projectRoot, folder, { home });
    let row: InstalledSkill | undefined;
    for (const r of rows) if ((await real(r.path)) === realTarget) row = r;
    if (!row) return { status: 404, error: '설치된 스킬 폴더가 아닙니다' };
    if (row.skillId) return { status: 409, error: '색인에 있는 스킬입니다. 스킬 상세 화면에서 확인하세요' };
    return { scope, projectPath: projectRoot, row };
  }
  return { status: 403, error: '설치됨 화면의 스킬 폴더만 검사할 수 있습니다' };
}

export function lintRouter(ctx: AppContext, opts: { home?: string } = {}): Router {
  const r = Router();
  r.post('/lint-skill', async (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown; projectPath?: unknown };
    const found = await findLintTarget(ctx.store, body.path, body.projectPath, opts.home ?? homedir());
    if ('error' in found) {
      res.status(found.status).json({ error: found.error });
      return;
    }
    try {
      const result = await lintSkillFolder(found.row.path, { store: ctx.store, settings: getSettings(ctx.store) });
      res.json({ ...result, scope: found.scope, projectPath: found.projectPath, agentsReading: found.row.agents });
    } catch (err) {
      res.status(500).json({ error: `검사하지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });
  return r;
}
