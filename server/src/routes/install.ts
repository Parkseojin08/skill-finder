import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { RiskFlag } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import { buildSteps, installAgents, planInstall } from '../install/plan.ts';
import { installIsHighRisk } from '../install/acks.ts';
import { CLAUDE_CODE } from '../install/agents.ts';
import { recheckInstall, type HeadLookup } from '../install/recheck.ts';
import { lastInsertedLogId, recordInstallCheck, runInstallScan, scanNeedsTick, type InstallScanResult } from '../install/record.ts';
import { executeInstall } from '../install/run.ts';
import { existingAgentFolders, undetectedAgents } from '../install/targets.ts';
import { forgetPlugins, installedPluginCommits, listInstalledPlugins, pathKey, pluginCommitKey, pluginIndexInfo, pluginSkills, scanInstalledSkills, scanPluginSkills, type InstalledPlugin } from '../install/installed.ts';
import { indexItem, storeLookup, type ResultItem } from '../search/result.ts';
import { uninstallPlugin, uninstallSkill } from '../install/uninstall.ts';
import { dropQuarantine, quarantineFolder, type QuarantineOutcome } from '../install/quarantine.ts';
import { isAgentId, isProjectDir } from '../install/validate.ts';
import { getSettings } from '../settings.ts';
import { maskSecrets } from '../util/log.ts';
import { FolderPickerUnavailable, pickFolder } from '../util/folderPicker.ts';
import { ndjson } from '../util/ndjson.ts';
import { isPlainFolderName, resolveDroppedFolder } from '../util/resolveFolder.ts';

const Body = z.object({
  id: z.string().min(1).max(500),
  scope: z.enum(['user', 'project', 'local']),
  projectPath: z.string().max(1000).optional(),
  /**
   * The same-name folder(s) the confirm dialog showed as replaced. Only those may be replaced without another
   * check: a dialog opened on an earlier preview (another scope or folder) names another one (review 2026-11-02).
   * Several when other agents' folders are written too (F9 stage 2).
   */
  overwrite: z.union([z.string().max(2000), z.array(z.string().max(2000)).max(10)]).optional(),
  /**
   * What the confirm dialog had ticked: `high`, "위 명령과 위험 신호를 확인했습니다" (feature review P7), which also
   * covers a check that could not run; `overwrite` and `scanFailed` are recorded with the install (F7).
   */
  acks: z.object({ high: z.boolean().optional(), overwrite: z.boolean().optional(), scanFailed: z.boolean().optional() }).optional(),
  /** The agents to install for (F9 stage 2, decision 12); Claude Code alone when absent. skills CLI installs only. */
  agents: z.array(z.string().max(40)).max(10).optional(),
});

const UninstallBody = z.object({
  kind: z.enum(['plugin', 'skill']),
  /** plugin id (name@marketplace) or skill folder name */
  id: z.string().min(1).max(300),
  scope: z.enum(['user', 'project', 'local']),
  projectPath: z.string().max(1000).optional(),
  /** Whose skill folder (agents.ts) a skill is removed from; Claude Code's when absent (D#0763, widened in F9 stage 2). */
  agent: z.string().max(40).optional(),
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

/** One install, removal or restore at a time (routes/quarantine.ts takes the same turn for a restore). */
export function takeInstallTurn(): boolean {
  if (installing) return false;
  installing = true;
  return true;
}
export function endInstallTurn(): void {
  installing = false;
}

/** How the install recheck asks git for a head (B6), and the home folder for the user scope; tests replace them. */
export type InstallRouterOptions = { head?: HeadLookup; home?: string };

export function installRouter(ctx: AppContext, opts: InstallRouterOptions = {}): Router {
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
    // the agents (F9 stage 2): known ids only, set up on this PC; a plugin is Claude Code's only
    const asked = parsed.data.agents ?? [];
    if (asked.some((a) => !isAgentId(a))) {
      res.status(400).json({ error: '알 수 없는 에이전트입니다' });
      return;
    }
    const agents = installAgents(asked);
    if (plan.method !== 'skills-cli' && agents.some((a) => a !== CLAUDE_CODE)) {
      res.status(400).json({ error: '플러그인은 Claude Code에만 설치할 수 있습니다' });
      return;
    }
    if (undetectedAgents(agents).length) {
      res.status(400).json({ error: '이 PC에서 찾지 못한 에이전트에는 설치하지 않습니다' });
      return;
    }
    const acks = { high: parsed.data.acks?.high === true, overwrite: parsed.data.acks?.overwrite === true, scanFailed: parsed.data.acks?.scanFailed === true };
    // high risk needs the dialog's tick, which the request carries; without it nothing runs (as for the overwrite below)
    if (!acks.high && installIsHighRisk(store, skill, plan)) {
      res.status(400).json({ error: '위험 높음 스킬입니다. 설치 확인 창에서 명령과 위험 신호를 확인했다고 체크한 뒤 다시 설치하세요.' });
      return;
    }
    let replaced = false;
    /** F14: the folders the install replaces, copied first (the same skill unchanged is not: nothing would be lost). */
    const toKeep: string[] = [];
    if (plan.method === 'skills-cli' && scope !== 'local') {
      const confirmed = new Set(typeof parsed.data.overwrite === 'string' ? [parsed.data.overwrite] : (parsed.data.overwrite ?? []));
      for (const existing of await existingAgentFolders(store, skill.id, plan.skillName!, scope, projectPath, agents, opts.home)) {
        if (!(existing.same === true && existing.change === 'same')) toKeep.push(existing.path);
        if (existing.same === true) continue;
        if (!confirmed.has(existing.path)) {
          res.status(409).json({ error: `${existing.path}에 같은 이름의 다른 스킬이 있습니다. 설치 확인 창에서 덮어쓰기를 확인한 뒤 다시 설치하세요.` });
          return;
        }
        replaced = true;
      }
    }
    if (installing) {
      res.status(409).json({ error: '다른 설치가 진행 중입니다' });
      return;
    }
    installing = true;
    let out: ReturnType<typeof ndjson> | null = null;
    try {
      // B6 (decision 11): what is fetched now is what was checked, or nothing is installed and that one is checked again
      const recheck = await recheckInstall(ctx, skill, plan, opts.head);
      if (!recheck.ok) {
        res.status(recheck.code === 'changedSinceScan' ? 409 : 502).json({ ...recheck, error: recheck.message });
        return;
      }
      // the file or run-config check, as the install tab showed it (cached): what needs the tick is enforced here too
      let scan: InstallScanResult;
      try {
        scan = await runInstallScan(ctx, skill, plan);
      } catch (err) {
        scan = { kind: 'failed', error: String((err as Error).message ?? err) };
      }
      if (!acks.high && scanNeedsTick(scan)) {
        res.status(400).json({
          error:
            scan.kind === 'failed'
              ? '함께 설치될 파일을 검사하지 못했습니다. 설치 확인 창에서 위험 신호를 확인했다고 체크한 뒤 다시 설치하세요.'
              : '함께 설치되는 파일이나 플러그인 설정에 위험 높음 신호가 있습니다. 설치 확인 창에서 확인했다고 체크한 뒤 다시 설치하세요.',
        });
        return;
      }
      out = ndjson(res);
      const stream = out;
      const settings = getSettings(store);
      const env = { ...process.env, ...(settings.telemetryDisabled ? { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } : {}) };
      const steps = buildSteps(plan, scope, projectPath, agents);
      const kept: QuarantineOutcome[] = [];
      for (const path of toKeep) {
        const k = await quarantineFolder(store, ctx.config.dataDir, { reason: 'overwrite', name: plan.skillName!, skillId: skill.id, scope: scope as 'user' | 'project', projectPath, agent: null, originalPath: path });
        if (!k.kept && k.reason === 'failed') {
          for (const done of kept) if (done.kept) await dropQuarantine(store, ctx.config.dataDir, done.id);
          stream.send({ type: 'result', ok: false, exitCode: -1, message: '덮어쓰기 전에 되돌리기용 복사본을 만들지 못해 설치하지 않았습니다', quarantine: [k] });
          return;
        }
        kept.push(k);
        if (k.kept) stream.send({ type: 'log', line: `기존 폴더 복사본을 보관했습니다: ${path}`, stream: 'info' });
        else if (k.reason === 'tooBig') stream.send({ type: 'log', line: `기존 폴더가 20MB를 넘어 복사본을 보관하지 않았습니다: ${path}`, stream: 'info' });
      }
      const result = await executeInstall(plan, steps, (line, s) => stream.send({ type: 'log', line, stream: s ?? 'stdout' }), env);
      store.logInstall({
        skill_id: skill.id,
        plugin_id: plan.pluginId ?? null,
        method: plan.method,
        scope,
        project_path: projectPath,
        argv: result.argv,
        exit_code: result.exitCode,
        output: result.output,
        ref: plan.pinnedRef ?? skill.ref,
        skill_md_sha256: skill.skill_md_sha256,
        risk_level: skill.risk_level,
      });
      // F7: what was seen and ticked, in the row just added (store.ts keeps its writer as it is)
      const logId = lastInsertedLogId(store);
      // the install already ran: recording what was seen must not turn its answer into a failure (review 2026-11-05)
      if (logId != null) {
        try {
          const flags = [...new Set([...(JSON.parse(skill.risk_json ?? '[]') as string[]), ...(plan.method === 'plugin' && plan.pluginId ? store.listSkillsByPlugin(plan.pluginId).flatMap((s) => JSON.parse(s.risk_json ?? '[]') as string[]) : [])])];
          recordInstallCheck(store, logId, { flags: flags as RiskFlag[], scan, acks: { ...acks, overwrite: acks.overwrite || replaced, scanFailed: acks.scanFailed || scan.kind === 'failed' }, pinned: plan.method === 'skills-cli' && !!plan.pinnedRef });
        } catch (err) {
          console.warn('[install] 설치 기록을 남기지 못했습니다:', String((err as Error).message ?? err).slice(0, 200));
        }
      }
      forgetPlugins();
      let message = result.message;
      if (result.ok) {
        store.logEvent('install', skill.id, null);
        // a plugin cannot be pinned: say when Claude Code fetched another commit than the one checked (UI debate 3-3)
        if (plan.method === 'plugin' && plan.pluginId) {
          const info = pluginIndexInfo(store, plan.pluginId, installedPluginCommits().get(pluginCommitKey(plan.pluginId, scope, projectPath)));
          if (info.change === 'changed') message += ' 설치된 커밋이 위험 검사를 한 커밋과 다릅니다. 설치됨 화면에서 위험 등급을 다시 확인하세요.';
        }
      }
      stream.send({ type: 'result', ok: result.ok, exitCode: result.exitCode, message, ...(kept.length ? { quarantine: kept } : {}) });
    } catch (err) {
      const message = `실행 실패: ${String((err as Error).message ?? err).slice(0, 200)}`;
      if (out) out.send({ type: 'result', ok: false, exitCode: -1, message });
      else if (!res.headersSent) res.status(500).json({ error: message });
    } finally {
      installing = false;
      out?.end();
    }
  });

  // What the app ran: installs and removals with their result and output (review 2026-11-02), to find why one
  // failed without the console. Output masked like the log file and cut to 4,000 characters.
  r.get('/install/log', (_req, res) => {
    res.json({
      entries: store.listInstallLog(50).map((e) => ({
        id: e.id,
        at: e.created_at,
        method: e.method,
        scope: e.scope,
        projectPath: e.project_path,
        target: e.plugin_id ?? e.skill_id,
        ok: e.exit_code === 0,
        output: maskSecrets(e.output ?? '').slice(-4000),
      })),
    });
  });

  // Whether an install or removal is running: the page asks when its result stream ended without a result
  // (project review F4), to say "still installing" or "check the 설치됨 screen".
  r.get('/install/status', (_req, res) => {
    res.json({ installing });
  });

  r.post('/uninstall', async (req, res) => {
    const parsed = UninstallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '요청 형식이 올바르지 않습니다' });
      return;
    }
    const b = parsed.data;
    const projectPath = b.projectPath?.trim() || null;
    if (b.agent !== undefined && (!isAgentId(b.agent) || (b.kind === 'plugin' && b.agent !== CLAUDE_CODE))) {
      res.status(400).json({ error: '알 수 없는 에이전트입니다' });
      return;
    }
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
        const agent = isAgentId(b.agent) ? b.agent : CLAUDE_CODE;
        const scope = b.scope;
        result = await uninstallSkill(b.id, scope, projectPath, env, agent, opts.home, (target) =>
          quarantineFolder(store, ctx.config.dataDir, { reason: 'delete', name: b.id, skillId: null, scope, projectPath, agent, originalPath: target }),
        );
        // nothing was removed: the copy made for it is of no use
        if (!result.ok && result.quarantine?.kept) await dropQuarantine(store, ctx.config.dataDir, result.quarantine.id);
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
      forgetPlugins();
      const quarantine = 'quarantine' in result ? result.quarantine : undefined;
      res.status(result.ok ? 200 : 500).json(result.ok ? { ok: true, message: result.message, ...(quarantine ? { quarantine } : {}) } : { error: result.message });
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
    const listed = await listInstalledPlugins(projectPath ?? homedir(), true);
    const commits = installedPluginCommits();
    // with a folder, another project's project and local plugins are not this one's (user report 2026-11-04)
    const plugins = listed.plugins.filter((o) => !projectPath || (o.scope !== 'project' && o.scope !== 'local') || pathKey(o.projectPath ?? '') === pathKey(projectPath)).map((o) => {
      const { scope, id: pid } = o;
      const ownProject = o.projectPath;
      // `claude plugin list` reports enabled for the folder it runs in; read the settings file that owns this install instead.
      const fromSettings = enabledInSettings(pid, scope, ownProject);
      return {
        id: pid,
        version: o.version,
        scope,
        enabled: fromSettings ?? o.enabled ?? null,
        enabledWhere: scope === 'user' ? '모든 프로젝트' : scope === 'project' || scope === 'local' ? ownProject : null,
        installPath: o.installPath,
        projectPath: ownProject,
        removeCommand: ['user', 'project', 'local'].includes(scope) ? `claude plugin uninstall ${pid} --scope ${scope}` : null,
        ...pluginIndexInfo(store, pid, commits.get(pluginCommitKey(pid, scope, ownProject))),
        skills: pluginSkills(store, pid),
      };
    });
    const skills = [
      ...(await scanInstalledSkills(store, 'user', null)),
      ...(projectPath ? await scanInstalledSkills(store, 'project', projectPath) : []),
    ];
    // The skills of the plugins that apply here: everyone's (user, synced) and this folder's. Without a folder the
    // project plugins listed above belong to other folders. One row per folder: a plugin installed for the user and
    // for a project shares its install folder (code review 2026-11-04).
    const applying = plugins.filter((p) => (p.scope !== 'project' && p.scope !== 'local') || projectPath);
    const seen = new Set<string>();
    const pluginSkillRows = (await Promise.all(applying.map((p) => scanPluginSkills(store, { ...p, enabled: typeof p.enabled === 'boolean' ? p.enabled : null }))))
      .flat()
      .filter((s) => !seen.has(s.path) && seen.add(s.path));
    // the index's card for each indexed one: provider, category and install method for the side filters
    const lookup = storeLookup(store);
    const items: Record<string, ResultItem> = {};
    for (const s of [...skills, ...pluginSkillRows]) {
      const row = s.skillId ? store.getSkill(s.skillId) : undefined;
      if (row && !items[row.id]) items[row.id] = indexItem(store, lookup, row);
    }
    res.json({ plugins, pluginError: listed.error, skills, pluginSkills: pluginSkillRows, items, projects: store.listInstalledProjects() });
  });

  // What is installed, by index id, for the "설치됨" badges on results (UI debate 3-1). Project skills are those of
  // `projectPath` (the folder README 추천 analyzed, user request 2026-11-04), else of the default project folder in
  // the settings; with `projectPath`, project and local plugins of other folders are left out. Unknown ones are
  // simply absent: no badge, never "not installed".
  r.get('/installed/ids', async (req, res) => {
    const asked = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    if (asked && !isProjectDir(asked)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    const project = asked ?? getSettings(store).defaultProjectPath;
    const listed = await listInstalledPlugins();
    // "installed" badges mean installed for Claude Code: other agents' folders are not read here (review 2026-11-04)
    const skills = [
      ...(await scanInstalledSkills(store, 'user', null, undefined, { agents: 'claude' })),
      ...(isProjectDir(project) ? await scanInstalledSkills(store, 'project', project, undefined, { agents: 'claude' }) : []),
    ];
    const inFolder = (p: InstalledPlugin) => !asked || (p.scope !== 'project' && p.scope !== 'local') || pathKey(p.projectPath ?? '') === pathKey(asked);
    res.json({
      plugins: listed.plugins.filter(inFolder).map((p) => ({ id: p.id, scope: p.scope })),
      skills: skills.filter((s) => s.skillId).map((s) => ({ id: s.skillId, scope: s.scope })),
    });
  });

  return r;
}
