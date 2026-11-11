// "최근 지운·바꾼 것" (feature review F14, decision 15): the copies kept before a skill folder was deleted or
// replaced, undo for each (only where nothing is now), and the plugins removed lately with their reinstall command
// (plugins are not copied). Also the size of a folder about to go, so the confirm dialog can say when it is too big
// to keep. State changes sit under the app's /api checks (header, same-origin Origin) like every other route.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { isAgentId } from '../install/validate.ts';
import { agentSkillsRoot, PLUGIN_ID_RE, SKILL_FOLDER_RE } from '../install/uninstall.ts';
import {
  inQuarantine,
  listQuarantine,
  measureFolder,
  QUARANTINE_KEEP_MS,
  QUARANTINE_MAX_BYTES,
  QUARANTINE_MAX_ENTRIES,
  restoreQuarantine,
  skillFolderTarget,
} from '../install/quarantine.ts';
import { CLAUDE_CODE } from '../install/agents.ts';
import { endInstallTurn, takeInstallTurn } from './install.ts';
import { join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';

export type QuarantineRouterOptions = { home?: string };

const PLUGIN_SCOPES = new Set(['user', 'project', 'local']);

export function quarantineRouter(ctx: AppContext, opts: QuarantineRouterOptions = {}): Router {
  const r = Router();
  const { store } = ctx;
  const home = () => opts.home ?? homedir();
  const dataDir = ctx.config.dataDir;

  r.get('/quarantine', (_req, res) => {
    const entries = listQuarantine(store).map((q) => ({
      id: q.id,
      at: q.created_at,
      reason: q.reason,
      name: q.name,
      skillId: q.skill_id,
      scope: q.scope,
      projectPath: q.project_path,
      agent: q.agent,
      originalPath: q.original_path,
      bytes: q.bytes,
      files: q.files,
      restoredAt: q.restored_at,
      /** The copy is still there to put back. */
      available: !q.restored_at && inQuarantine(dataDir, q.stored_path) && existsSync(q.stored_path),
    }));
    const since = new Date(Date.now() - QUARANTINE_KEEP_MS).toISOString();
    const plugins = (
      store.db
        .prepare(
          `SELECT id, created_at, plugin_id, scope, project_path FROM install_log
            WHERE method = 'uninstall-plugin' AND exit_code = 0 AND created_at >= ? ORDER BY id DESC LIMIT ?`,
        )
        .all(since, QUARANTINE_MAX_ENTRIES) as Array<{ id: number; created_at: string; plugin_id: string | null; scope: string; project_path: string | null }>
    )
      .filter((p) => p.plugin_id && PLUGIN_ID_RE.test(p.plugin_id) && PLUGIN_SCOPES.has(p.scope))
      .map((p) => ({
        id: p.id,
        at: p.created_at,
        pluginId: p.plugin_id!,
        scope: p.scope,
        projectPath: p.project_path,
        // run in the project folder for project and local scopes, as the app ran the removal
        command: `claude plugin install ${p.plugin_id} --scope ${p.scope}`,
      }));
    res.json({ entries, plugins, limits: { maxBytes: QUARANTINE_MAX_BYTES, keepDays: QUARANTINE_KEEP_MS / 86_400_000, maxEntries: QUARANTINE_MAX_ENTRIES } });
  });

  r.post('/quarantine/:id/restore', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: '요청 형식이 올바르지 않습니다' });
      return;
    }
    if (!takeInstallTurn()) {
      res.status(409).json({ error: '다른 설치·삭제가 진행 중입니다' });
      return;
    }
    try {
      const out = await restoreQuarantine(store, dataDir, id, home());
      if (!out.ok) {
        res.status(out.status).json({ error: out.error });
        return;
      }
      // not written to install_log: other readers take its rows as installs (watch/notices.ts, projects); the
      // quarantine row's restored_at is the record
      res.json({ ok: true, path: out.path });
    } catch (err) {
      res.status(500).json({ error: `되돌리지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    } finally {
      endInstallTurn();
    }
  });

  // How big a skill folder about to be deleted (scope, project, agent, folder: as /uninstall names it) or replaced
  // (scope, project, path: as the install preview shows it) is: over 20MB, no copy is kept.
  r.get('/quarantine/size', async (req, res) => {
    const q = req.query;
    const scope = q.scope;
    const projectPath = typeof q.projectPath === 'string' && q.projectPath.trim() ? q.projectPath.trim() : null;
    let target: string | null = null;
    if (typeof q.folder === 'string') {
      const agent = q.agent === undefined ? CLAUDE_CODE : isAgentId(q.agent) ? q.agent : null;
      if (agent && (scope === 'user' || scope === 'project') && SKILL_FOLDER_RE.test(q.folder) && !q.folder.includes('..')) {
        const place = scope === 'user' || projectPath ? agentSkillsRoot(agent, scope, projectPath, home()) : null;
        if (place) target = skillFolderTarget(scope, projectPath, join(place.dir, q.folder), home());
      }
    } else target = skillFolderTarget(scope, projectPath, q.path, home());
    if (!target) {
      res.status(400).json({ error: '허용된 설치 위치의 스킬 폴더가 아닙니다' });
      return;
    }
    const st = await lstat(resolve(target)).catch(() => null);
    if (!st) {
      res.json({ exists: false, link: false, bytes: 0, files: 0, over: false, limit: QUARANTINE_MAX_BYTES });
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      res.json({ exists: true, link: st.isSymbolicLink(), bytes: 0, files: 0, over: false, limit: QUARANTINE_MAX_BYTES });
      return;
    }
    const size = await measureFolder(target).catch(() => null);
    res.json({ exists: true, link: false, bytes: size?.bytes ?? 0, files: size?.files ?? 0, over: size?.over ?? false, limit: QUARANTINE_MAX_BYTES });
  });

  return r;
}
