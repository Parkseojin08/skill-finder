// POST /api/lint-skill {path, projectPath?} (feature review F15): "검사" on a 설치됨 row the index does not know (a
// skill written here). Only such a folder is read: one directly under an agent's skill folder of agents.ts (the
// places the 설치됨 screen lists, user or project), found by that screen's own scan with no index row. `..`, other
// places and a link leading out of the agents' folders are refused. Nothing is written or run.
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { agentFolders, AGENTS } from '../install/agents.ts';
import { pathKey, scanInstalledSkills, type InstalledSkill } from '../install/installed.ts';
import { isProjectDir } from '../install/validate.ts';
import { FolderMovedError, lintSkillFolder } from '../lint/lint.ts';
import { getSettings } from '../settings.ts';

/** `realPath`: where the folder really is, as judged; the reading must find it there still (lintSkillFolder). */
export type LintTarget = { scope: 'user' | 'project'; projectPath: string | null; row: InstalledSkill; realPath: string };
export type LintRefusal = { status: number; error: string };

/**
 * A path as its file system tells folders apart, for comparing only (pathKey: any case on Windows and macOS, and
 * either slash on Windows; as written on Linux). A path is taken apart (dirname, basename) before this, never after:
 * outside Windows node:path finds no folder in a backslash key.
 */
const placeKey = pathKey;

/**
 * Where a path really is: links followed, in the file system's own spelling (a Windows 8.3 short name becomes the
 * long one). Null when nothing is there. The path as written is no stand-in: it may spell the same folder another
 * way, and then looks like a different place.
 */
const realOf = (p: string): Promise<string | null> => realpath(p).catch(() => null);

type FileId = { dev: bigint; ino: bigint };
/** What a path leads to (links followed), by identity; null when nothing is there. */
const idOf = (p: string): Promise<FileId | null> => stat(p, { bigint: true }).catch(() => null);
const sameId = (a: FileId, b: FileId) => a.dev === b.dev && a.ino === b.ino;

/**
 * The installed skill a path names, as the 설치됨 screen lists it: the user's agent folders, or a project's (the one
 * given, else the one the path sits in). A refusal says why not.
 */
export async function findLintTarget(store: AppContext['store'], path: unknown, projectPath: unknown, home = homedir()): Promise<LintTarget | LintRefusal> {
  if (typeof path !== 'string' || !path || path.length > 1000 || !isAbsolute(path) || /[\0\r\n]/.test(path)) return { status: 400, error: '스킬 폴더의 절대경로가 필요합니다' };
  if (path.split(/[\\/]+/).includes('..')) return { status: 400, error: '경로에 ..를 쓸 수 없습니다' };
  if (projectPath != null && projectPath !== '' && !isProjectDir(projectPath)) return { status: 400, error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' };
  const target = resolve(path);
  // as resolve() left it: this platform's slashes and no trailing one (but for a root, which is no agent's folder)
  const parentDir = dirname(target);
  const parent = placeKey(parentDir);
  const folder = basename(target);

  // where the folder may be: the user's agent folders, the project given, or the project its path is in
  const places: Array<{ scope: 'user' | 'project'; root: string }> = [{ scope: 'user', root: home }];
  if (typeof projectPath === 'string' && projectPath) places.push({ scope: 'project', root: projectPath });
  else {
    for (const rel of new Set(AGENTS.map((a) => a.projectDir))) {
      const tail = placeKey(`${sep}${rel.split('/').join(sep)}`);
      if (parent.endsWith(tail)) {
        // cut from the parent as written (its key only changes the case, so the lengths agree): the answer's
        // projectPath keeps the folder's own spelling instead of a lower-case one
        const root = parentDir.length === parent.length ? parentDir.slice(0, -tail.length) : parent.slice(0, -tail.length);
        if (root && isProjectDir(root)) places.push({ scope: 'project', root });
      }
    }
  }
  for (const { scope, root } of places) {
    const dirs = agentFolders(scope, root).map((f) => f.dir);
    if (!dirs.some((d) => placeKey(d) === parent)) continue;
    // The path names a folder of this place. From here on by where things really are: the path as written and the
    // file system may spell one folder two ways (a Windows short name, a temporary folder that is itself a link),
    // so a folder that is not there is simply not installed, not a link leading out.
    const realTarget = await realOf(target);
    if (!realTarget) return { status: 404, error: '설치된 스킬 폴더가 아닙니다' };
    // A link may lead to another agent's folder (the skills CLI links them), never anywhere else. Folders are told
    // apart by identity (device and inode), not by spelling: a case-sensitive volume (possible on macOS too) can
    // hold Twin and twin side by side, which a comparison ignoring case would take for one.
    const targetId = await idOf(realTarget);
    const parentId = await idOf(dirname(realTarget));
    const dirIds = await Promise.all(dirs.map(idOf));
    if (!targetId || !parentId || !dirIds.some((d) => d && sameId(d, parentId))) return { status: 403, error: '에이전트 스킬 폴더 밖을 가리키는 링크는 검사하지 않습니다' };
    const projectRoot = scope === 'project' ? root : null;
    const rows = await scanInstalledSkills(store, scope, projectRoot, folder, { home });
    let row: InstalledSkill | undefined;
    for (const r of rows) {
      const at = await idOf(r.path);
      if (at && sameId(at, targetId)) row = r;
    }
    if (!row) return { status: 404, error: '설치된 스킬 폴더가 아닙니다' };
    if (row.skillId) return { status: 409, error: '색인에 있는 스킬입니다. 스킬 상세 화면에서 확인하세요' };
    return { scope, projectPath: projectRoot, row, realPath: realTarget };
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
      // the folder judged above, where it was judged to be: a link changed in between is not followed somewhere else
      const result = await lintSkillFolder(found.row.path, { store: ctx.store, settings: getSettings(ctx.store), expectRealPath: found.realPath });
      res.json({ ...result, scope: found.scope, projectPath: found.projectPath, agentsReading: found.row.agents });
    } catch (err) {
      if (err instanceof FolderMovedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: `검사하지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });
  return r;
}
