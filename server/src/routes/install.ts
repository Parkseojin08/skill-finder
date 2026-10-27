import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { extractSkillMeta } from '../analyze/frontmatter.ts';
import { runClaude } from '../claude/cli.ts';
import type { AppContext } from '../context.ts';
import { buildSteps, planInstall } from '../install/plan.ts';
import { executeInstall, parseJsonArray } from '../install/run.ts';
import { uninstallPlugin, uninstallSkill } from '../install/uninstall.ts';
import { isProjectDir } from '../install/validate.ts';
import { getSettings } from '../settings.ts';
import { FolderPickerUnavailable, pickFolder } from '../util/folderPicker.ts';
import { ndjson } from '../util/ndjson.ts';
import { isPlainFolderName, resolveDroppedFolder } from '../util/resolveFolder.ts';
import { truncate } from '../util/sanitize.ts';
import { SKILLS_CLI_VERSION } from '../config.ts';

const Body = z.object({
  id: z.string().min(1).max(500),
  scope: z.enum(['user', 'project', 'local']),
  projectPath: z.string().max(1000).optional(),
});

const UninstallBody = z.object({
  kind: z.enum(['plugin', 'skill']),
  /** plugin id (name@marketplace) or skill folder name */
  id: z.string().min(1).max(300),
  scope: z.enum(['user', 'project', 'local']),
  projectPath: z.string().max(1000).optional(),
});

/** enabledPlugins[id] from the settings file that owns an install (user / project / local scope); null when unknown. */
function enabledInSettings(id: string, scope: string, projectPath: string | null): boolean | null {
  const file =
    scope === 'user'
      ? join(homedir(), '.claude', 'settings.json')
      : scope === 'project' && projectPath
        ? join(projectPath, '.claude', 'settings.json')
        : scope === 'local' && projectPath
          ? join(projectPath, '.claude', 'settings.local.json')
          : null;
  if (!file) return null;
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins?.[id];
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

let installing = false;
let picking = false;

async function scanSkills(dir: string, scope: 'user' | 'project') {
  const out: Array<{ scope: string; path: string; folder: string; name: string; description: string; removeCommand: string }> = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const path = join(dir, name);
    try {
      const raw = await readFile(join(path, 'SKILL.md'), 'utf8');
      const meta = extractSkillMeta(raw, name);
      out.push({
        scope,
        path,
        folder: name,
        name: meta.name,
        description: truncate(meta.description, 200),
        removeCommand: `npx skills@${SKILLS_CLI_VERSION} remove ${/\s/.test(name) ? `"${name}"` : name} -a claude-code -y${scope === 'user' ? ' -g' : ''}`,
      });
    } catch {
      // not a skill folder
    }
  }
  return out;
}

export function installRouter(ctx: AppContext): Router {
  const r = Router();
  const { store } = ctx;

  r.post('/install', async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '요청 형식이 올바르지 않습니다' });
      return;
    }
    const { id, scope } = parsed.data;
    const projectPath = parsed.data.projectPath?.trim() || null;
    const skill = store.getSkill(id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const plan = planInstall(skill, plugin, plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null);
    if (plan.method === 'manual-only' || plan.disabled) {
      res.status(400).json({ error: plan.reason ?? '앱에서 설치할 수 없는 스킬입니다' });
      return;
    }
    if (!plan.scopes.includes(scope)) {
      res.status(400).json({ error: '이 설치 방식에서 지원하지 않는 범위입니다' });
      return;
    }
    if (scope !== 'user' && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    if (installing) {
      res.status(409).json({ error: '다른 설치가 진행 중입니다' });
      return;
    }
    installing = true;
    const out = ndjson(res);
    try {
      const settings = getSettings(store);
      const env = { ...process.env, ...(settings.telemetryDisabled ? { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } : {}) };
      const steps = buildSteps(plan, scope, projectPath);
      const result = await executeInstall(plan, steps, (line, stream) => out.send({ type: 'log', line, stream: stream ?? 'stdout' }), env);
      store.logInstall({
        skill_id: skill.id,
        plugin_id: plan.pluginId ?? null,
        method: plan.method,
        scope,
        project_path: projectPath,
        argv: result.argv,
        exit_code: result.exitCode,
        output: result.output,
      });
      if (result.ok) store.logEvent('install', skill.id, null);
      out.send({ type: 'result', ok: result.ok, exitCode: result.exitCode, message: result.message });
    } catch (err) {
      out.send({ type: 'result', ok: false, exitCode: -1, message: `실행 실패: ${String((err as Error).message ?? err).slice(0, 200)}` });
    } finally {
      installing = false;
      out.end();
    }
  });

  r.post('/uninstall', async (req, res) => {
    const parsed = UninstallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '요청 형식이 올바르지 않습니다' });
      return;
    }
    const b = parsed.data;
    const projectPath = b.projectPath?.trim() || null;
    if (b.scope !== 'user' && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 범위는 존재하는 프로젝트 폴더가 필요합니다' });
      return;
    }
    if (installing) {
      res.status(409).json({ error: '다른 설치·삭제가 진행 중입니다' });
      return;
    }
    installing = true;
    try {
      let result;
      if (b.kind === 'plugin') {
        result = await uninstallPlugin(b.id, b.scope, projectPath);
      } else {
        if (b.scope === 'local') {
          res.status(400).json({ error: '스킬에는 로컬 범위가 없습니다' });
          return;
        }
        const settings = getSettings(store);
        const env = { ...process.env, ...(settings.telemetryDisabled ? { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } : {}) };
        result = await uninstallSkill(b.id, b.scope, projectPath, env);
      }
      store.logInstall({
        skill_id: b.kind === 'skill' ? b.id : null,
        plugin_id: b.kind === 'plugin' ? b.id : null,
        method: `uninstall-${b.kind}`,
        scope: b.scope,
        project_path: projectPath,
        argv: [],
        exit_code: result.ok ? 0 : 1,
        output: result.output,
      });
      res.status(result.ok ? 200 : 500).json(result.ok ? { ok: true, message: result.message } : { error: result.message });
    } catch (err) {
      res.status(500).json({ error: `삭제 실패: ${String((err as Error).message ?? err).slice(0, 200)}` });
    } finally {
      installing = false;
    }
  });

  r.post('/pick-folder', async (req, res) => {
    if (picking) {
      res.status(409).json({ error: '폴더 선택 창이 이미 열려 있습니다' });
      return;
    }
    picking = true;
    try {
      const initial = typeof req.body?.initial === 'string' ? req.body.initial : null;
      res.json({ path: await pickFolder(initial) });
    } catch (err) {
      res.status(500).json({ error: err instanceof FolderPickerUnavailable ? err.message : '폴더 선택 창을 열지 못했습니다' });
    } finally {
      picking = false;
    }
  });

  // Drag & drop: the browser only knows the dropped folder's name and contents; find its absolute path.
  const DropBody = z.object({ name: z.string().min(1).max(255), entries: z.array(z.string().max(255)).max(200) });
  r.post('/resolve-folder', (req, res) => {
    const parsed = DropBody.safeParse(req.body);
    if (!parsed.success || !isPlainFolderName(parsed.data.name)) {
      res.status(400).json({ error: '폴더 이름이 올바르지 않습니다' });
      return;
    }
    const hints = [getSettings(ctx.store).defaultProjectPath].filter(Boolean);
    res.json({ matches: resolveDroppedFolder(parsed.data.name, parsed.data.entries, hints) });
  });

  r.get('/installed', async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    if (projectPath && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    let plugins: unknown[] = [];
    let pluginError: string | null = null;
    try {
      const list = await runClaude(['plugin', 'list', '--json'], { cwd: projectPath ?? homedir(), timeoutMs: 60_000 });
      plugins = (parseJsonArray(list.stdout) ?? []).map((p) => {
        const o = p as Record<string, unknown>;
        const scope = typeof o.scope === 'string' ? o.scope : 'user';
        const pid = String(o.id ?? '');
        const ownProject = typeof o.projectPath === 'string' ? o.projectPath : null;
        // `claude plugin list` reports enabled for the folder it runs in; read the settings file that owns this install instead.
        const fromSettings = enabledInSettings(pid, scope, ownProject);
        return {
          id: pid,
          version: o.version ?? null,
          scope,
          enabled: fromSettings ?? o.enabled ?? null,
          enabledWhere: scope === 'user' ? '모든 프로젝트' : scope === 'project' || scope === 'local' ? ownProject : null,
          installPath: o.installPath ?? null,
          projectPath: o.projectPath ?? null,
          removeCommand: ['user', 'project', 'local'].includes(scope) ? `claude plugin uninstall ${pid} --scope ${scope}` : null,
        };
      });
      if (list.exitCode !== 0) pluginError = 'claude plugin list 실패';
    } catch (err) {
      pluginError = String((err as Error).message ?? err);
    }
    const skills = [
      ...(await scanSkills(join(homedir(), '.claude', 'skills'), 'user')),
      ...(projectPath ? await scanSkills(join(projectPath, '.claude', 'skills'), 'project') : []),
    ];
    res.json({ plugins, pluginError, skills });
  });

  return r;
}
