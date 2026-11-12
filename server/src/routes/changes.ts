// Changes to what is installed (feature review F6, F7): the diff of an installed SKILL.md against the indexed
// commit, the notices, and the install history as one timeline. Read-only except marking notices seen.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { skillMdPath } from '../discovery/tree.ts';
import { pathKey, sameName, scanInstalledSkills } from '../install/installed.ts';
import { isProjectDir } from '../install/validate.ts';
import { isPlainFolderName } from '../util/resolveFolder.ts';
import { unifiedDiff } from '../watch/diff.ts';
import { listInstallHistory, listNotices, markNoticesSeen, noticeCounts, type InstallLogEntry, type Notice } from '../watch/notices.ts';

const SeenBody = z.object({ ids: z.array(z.number().int().positive()).max(1000).optional() });

/**
 * Where an installed skill folder is: a folder directly in Claude Code's skills folder, personal
 * (`~/.claude/skills/<folder>`) or a project's (`<project>/.claude/skills/<folder>`). Anything else is refused, so
 * the diff reads no file outside the folders the installed scan lists. Other agents' folders are shown only and not
 * compared (the app installs into Claude Code's alone).
 */
export function claudeSkillFolder(path: unknown, home: string): { scope: 'user' | 'project'; root: string; folder: string; path: string } | null {
  if (typeof path !== 'string' || !path || path.length > 2000 || !isAbsolute(path) || /[\0\r\n]/.test(path)) return null;
  const full = resolve(path);
  const folder = basename(full);
  const skills = dirname(full);
  const claude = dirname(skills);
  if (!isPlainFolderName(folder) || !sameName(basename(skills), 'skills') || !sameName(basename(claude), '.claude')) return null;
  const root = dirname(claude);
  if (pathKey(root) === pathKey(home)) return { scope: 'user', root, folder, path: full };
  return isProjectDir(root) ? { scope: 'project', root, folder, path: full } : null;
}

const flagsOf = (json: string | null): string[] => {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export type HistoryEvent = ({ type: 'notice'; at: string } & Notice) | ({ type: 'install'; at: string } & Omit<InstallLogEntry, 'at'>);

export function changesRouter(ctx: AppContext, opts: { home?: string } = {}): Router {
  const r = Router();
  const { store } = ctx;
  const home = () => opts.home ?? homedir();

  // F6 "차이 보기": the installed SKILL.md against the indexed commit's, line by line, and how the risk signals differ.
  r.get('/installed/diff', async (req, res) => {
    const where = claudeSkillFolder(req.query.path, home());
    if (!where) {
      res.status(400).json({ error: 'Claude Code 스킬 폴더 안의 설치된 스킬만 비교할 수 있습니다' });
      return;
    }
    const [hit] = (await scanInstalledSkills(store, where.scope, where.scope === 'project' ? where.root : null, where.folder, { agents: 'claude', home: home() })).filter(
      (s) => pathKey(s.path) === pathKey(where.path),
    );
    if (!hit) {
      res.status(404).json({ error: '설치된 스킬 폴더가 아닙니다' });
      return;
    }
    const row = hit.skillId ? store.getSkill(hit.skillId) : undefined;
    const local: { level: string; flags: string[] } = { level: hit.risk.level, flags: hit.risk.flags };
    if (!row?.repo || !row.ref || row.dir_path == null) {
      res.json({ path: hit.path, name: hit.name, skillId: hit.skillId, drift: hit.drift, indexed: null, local, diff: null, risk: null });
      return;
    }
    let localText: string;
    try {
      localText = await readFile(join(hit.path, 'SKILL.md'), 'utf8');
    } catch {
      res.status(404).json({ error: '설치된 SKILL.md를 읽지 못했습니다' });
      return;
    }
    const remote = await ctx.github.getRawText(row.repo, row.ref, skillMdPath(row.dir_path)).catch(() => null);
    if (remote?.text == null) {
      res.status(502).json({ error: `원본 SKILL.md를 GitHub에서 읽지 못했습니다${remote ? ` (${remote.status})` : ''}` });
      return;
    }
    const indexedFlags = flagsOf(row.risk_json);
    const diff = unifiedDiff(localText, remote.text, { labelA: `설치본 ${hit.path}`, labelB: `원본 ${row.repo}@${row.ref.slice(0, 7)}` });
    res.json({
      path: hit.path,
      name: hit.name,
      skillId: hit.skillId,
      drift: hit.drift,
      local,
      indexed: { repo: row.repo, ref: row.ref, dirPath: row.dir_path, level: row.risk_level, flags: indexedFlags, commitAt: row.last_commit_at },
      diff,
      // what reinstalling from the index would add and drop (SKILL.md text, the folder's files as listed)
      risk: { from: local.level, to: row.risk_level, added: indexedFlags.filter((f) => !local.flags.includes(f)), removed: local.flags.filter((f) => !indexedFlags.includes(f)) },
    });
  });

  // F7: changes to installed and favorite skills, newest first, and the unseen counts for the menu badge.
  r.get('/notices', (req, res) => {
    const unseenOnly = req.query.unseen === '1';
    const limit = Number(req.query.limit) || 200;
    res.json({ notices: listNotices(store, { unseenOnly, limit }), counts: noticeCounts(store) });
  });

  r.post('/notices/seen', (req, res) => {
    const parsed = SeenBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: '요청 형식이 올바르지 않습니다' });
      return;
    }
    const seen = markNoticesSeen(store, parsed.data.ids);
    res.json({ seen, counts: noticeCounts(store) });
  });

  // F7 timeline: notices and the app's installs and removals (with what was seen then) in one list, newest first.
  // `all=1`: everything kept, for the JSON export.
  r.get('/history/installs', (req, res) => {
    const all = req.query.all === '1';
    const limit = all ? 5000 : Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
    const events: HistoryEvent[] = [
      ...listNotices(store, { limit }).map((n) => ({ type: 'notice' as const, at: n.createdAt, ...n })),
      ...listInstallHistory(store, limit).map(({ at, ...e }) => ({ type: 'install' as const, at, ...e })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit);
    res.json({ exportedAt: new Date().toISOString(), events });
  });

  return r;
}
